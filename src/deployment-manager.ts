import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import axios, { isAxiosError } from 'axios';

interface DeploymentInfo {
  id: number;
  ref: string;
}

interface RepositoryContext {
  owner: string;
  repo: string;
}

async function validateSubscription(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH
  let repoPrivate: boolean | undefined

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    repoPrivate = eventData?.repository?.private
  }

  const upstream = 'strumwolf/delete-deployment-environment'
  const action = process.env.GITHUB_ACTION_REPOSITORY
  const docsUrl =
    'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions'

  core.info('')
  core.info('[1;36mStepSecurity Maintained Action[0m')
  core.info(`Secure drop-in replacement for ${upstream}`)
  if (repoPrivate === false)
    core.info('[32m✓ Free for public repositories[0m')
  core.info(`[36mLearn more:[0m ${docsUrl}`)
  core.info('')

  if (repoPrivate === false) return

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
  const body: Record<string, string> = {action: action || ''}
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      {timeout: 3000}
    )
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(
        `[1;31mThis action requires a StepSecurity subscription for private repositories.[0m`
      )
      core.error(
        `[31mLearn how to enable a subscription: ${docsUrl}[0m`
      )
      process.exit(1)
    }
    core.info('Timeout or API not reachable. Continuing to next step.')
  }
}


export async function run(): Promise<void> {
  try {
    await validateSubscription()
    // Get inputs from action.yml
    const token = core.getInput('token', { required: true });
    const environment = core.getInput('environment', { required: true });
    const targetRef = core.getInput('ref', { required: false });
    const onlyRemoveDeployments = core.getInput('onlyRemoveDeployments', { required: false }) === 'true';
    const onlyDeactivateDeployments = core.getInput('onlyDeactivateDeployments', { required: false }) === 'true';

    // Determine what operations to perform
    const shouldDeleteDeployments = !onlyDeactivateDeployments;
    const shouldDeleteEnvironment = !onlyRemoveDeployments && !onlyDeactivateDeployments;

    // Initialize GitHub client with rate limiting and preview headers
    const octokit = github.getOctokit(token, {
      throttle: {
        onRateLimit: (retryAfter = 0, options: any) => {
          core.warning(
            `Request quota exhausted for request ${options.method} ${options.url}`
          );
          if (options.request.retryCount === 0) {
            core.info(`Retrying after ${retryAfter} seconds!`);
            return true;
          }
        },
        onAbuseLimit: (retryAfter = 0, options: any) => {
          core.warning(
            `Abuse detected for request ${options.method} ${options.url}`
          );
          if (options.request.retryCount === 0) {
            core.info(`Retrying after ${retryAfter} seconds!`);
            return true;
          }
        },
      },
      previews: ['ant-man'],
    });
    const { owner, repo } = github.context.repo;

    core.info(`Starting deployment management for environment: ${environment}`);

    // Fetch all deployments for the environment
    const deployments = await fetchDeployments(octokit, { owner, repo }, environment, targetRef);
    
    if (deployments.length === 0) {
      core.info('No deployments found for the specified environment');
      return;
    }

    core.info(`Found ${deployments.length} deployment(s) to process`);

    // Deactivate all deployments
    await deactivateDeployments(octokit, { owner, repo }, deployments);

    // Delete deployments if requested
    if (shouldDeleteDeployments) {
      await deleteDeployments(octokit, { owner, repo }, deployments);
    }

    // Delete environment if requested
    if (shouldDeleteEnvironment) {
      await deleteEnvironment(octokit, { owner, repo }, environment);
    }

    core.info('Action completed successfully');
  } catch (error) {
    core.setFailed(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchDeployments(
  octokit: ReturnType<typeof github.getOctokit>,
  repoContext: RepositoryContext,
  environment: string,
  targetRef?: string
): Promise<DeploymentInfo[]> {
  const deployments: DeploymentInfo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await octokit.rest.repos.listDeployments({
      owner: repoContext.owner,
      repo: repoContext.repo,
      environment,
      ref: targetRef || undefined,
      per_page: perPage,
      page
    });

    const pageDeployments = response.data.map(deployment => ({
      id: deployment.id,
      ref: deployment.ref
    }));

    deployments.push(...pageDeployments);

    if (pageDeployments.length < perPage) {
      break;
    }
    page++;
  }

  return deployments;
}

async function deactivateDeployments(
  octokit: ReturnType<typeof github.getOctokit>,
  repoContext: RepositoryContext,
  deployments: DeploymentInfo[]
): Promise<void> {
  core.info('Deactivating deployments...');
  
  const promises = deployments.map(deployment =>
    octokit.rest.repos.createDeploymentStatus({
      owner: repoContext.owner,
      repo: repoContext.repo,
      deployment_id: deployment.id,
      state: 'inactive'
    })
  );

  await Promise.all(promises);
  core.info(`Successfully deactivated ${deployments.length} deployment(s)`);
}

async function deleteDeployments(
  octokit: ReturnType<typeof github.getOctokit>,
  repoContext: RepositoryContext,
  deployments: DeploymentInfo[]
): Promise<void> {
  core.info('Deleting deployments...');
  
  const promises = deployments.map(deployment =>
    octokit.rest.repos.deleteDeployment({
      owner: repoContext.owner,
      repo: repoContext.repo,
      deployment_id: deployment.id
    })
  );

  await Promise.all(promises);
  core.info(`Successfully deleted ${deployments.length} deployment(s)`);
}

async function deleteEnvironment(
  octokit: ReturnType<typeof github.getOctokit>,
  repoContext: RepositoryContext,
  environment: string
): Promise<void> {
  try {
    // Check if environment exists
    await octokit.rest.repos.getEnvironment({
      owner: repoContext.owner,
      repo: repoContext.repo,
      environment_name: environment
    });

    // Delete the environment
    core.info(`Deleting environment: ${environment}`);
    await octokit.rest.repos.deleteAnEnvironment({
      owner: repoContext.owner,
      repo: repoContext.repo,
      environment_name: environment
    });
    
    core.info(`Successfully deleted environment: ${environment}`);
  } catch (error: any) {
    if (error.status === 404) {
      core.info(`Environment ${environment} not found, skipping deletion`);
    } else {
      throw error;
    }
  }
}
