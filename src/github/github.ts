import { ConfigInterface } from "../config/config";
import * as github from "@actions/github";
import { HttpClient, HttpClientResponse } from "@actions/http-client";
import * as _ from "lodash";
import * as core from "@actions/core";

export class GithubClient {
  config: ConfigInterface;

  constructor(config: ConfigInterface) {
    this.config = config;
  }

  async getRunnerVersion(): Promise<string> {
    if (this.config.githubActionRunnerVersion)
      return this.config.githubActionRunnerVersion.replace("v", "");

    const httpClient = new HttpClient("http-client");
    const res: HttpClientResponse = await httpClient.get(
      "https://api.github.com/repos/actions/runner/releases/latest"
    );

    const body: string = await res.readBody();
    const obj = JSON.parse(body);
    return obj["tag_name"].replace("v", "");
  }

  async getRunnersWithLabels(labels: string[]) {
    const octokit = github.getOctokit(this.config.githubToken);
    var done = false;
    do {
      try {
        const runners = await octokit.rest.actions.listSelfHostedRunnersForRepo({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo
        });

        core.info(JSON.stringify(runners, null, 2));
        done = !Boolean(runners.data.total_count);
        const searchLabels = {
          labels: labels.map(function (label) {
            return { name: label };
          }),
        };

        //const mockRunnerData = {"total_count":2,"runners":[{"id":319,"name":"ip-192-168-0-139","os":"Linux","status":"online","busy":true,"labels":[{"id":297,"name":"self-hosted","type":"read-only"},{"id":298,"name":"Linux","type":"read-only"},{"id":299,"name":"X64","type":"read-only"},{"id":314,"name":"dow0w","type":"custom"}]},{"id":320,"name":"ip-192-168-11-102","os":"Linux","status":"online","busy":true,"labels":[{"id":297,"name":"self-hosted","type":"read-only"},{"id":298,"name":"Linux","type":"read-only"},{"id":299,"name":"X64","type":"read-only"},{"id":315,"name":"2pdrq","type":"custom"}]}]}
        return  _.filter(runners.data.runners, searchLabels);
      } catch (error) {
        core.error(`Failed to list github runners: ${error}`);
        throw error;
      }
    } while (done);
    return [];
  }

  async getRunnerRegistrationToken() {
    const octokit = github.getOctokit(this.config.githubToken);
    try {
      const response = await octokit.rest.actions.createRegistrationTokenForRepo(
        {
          owner: github.context.repo.owner,
          repo: github.context.repo.repo
        }
      );

      return response.data;
    } catch (error) {
      core.error(`Failed to get Runner registration token: ${error}`);
      throw error;
    }
  }

  async removeRunnersWithLabels(labels: string[]) {
    let deletedAll = true;
    try {
      const runners = await this.getRunnersWithLabels(labels);
      console.log("Found existing runners:", runners.map(r => r.id));
      const octokit = github.getOctokit(this.config.githubToken);
      for (const runner of runners) {
        const response =
          await octokit.rest.actions.deleteSelfHostedRunnerFromRepo({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            runner_id: runner.id,
          });
        deletedAll = deletedAll && response.status == 204;
      }
    } catch (error) {
      core.error(`Failed to delete runner: ${error}`);
    }
    return deletedAll;
  }

  // Borrowed from https://github.com/machulav/ec2-github-runner/blob/main/src/aws.js
  async pollForRunnerCreation(labels: string[]) {
    const timeoutMinutes = 5;
    const retryIntervalSeconds = 10;
    const quietPeriodSeconds = 30;
    let waitSeconds = 0;

    core.info(`Waiting ${quietPeriodSeconds}s before polling for runners`);
    await new Promise((r) => setTimeout(r, quietPeriodSeconds * 1000));
    core.info(`Polling for runners every ${retryIntervalSeconds}s`);

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        if (waitSeconds > timeoutMinutes * 60) {
          core.error("GitHub self-hosted runner creation error");
          clearInterval(interval);
          reject(
            `A timeout of ${timeoutMinutes} minutes is exceeded. Please ensure your EC2 instance has access to the Internet.`
          );
        }

        for (const runner of await this.getRunnersWithLabels(labels)) {
          if (runner.status === "online") {
            core.info(
              `GitHub self-hosted runner ${runner.name} with label ${labels} is created and ready to use. Continuing assuming other runners will come online.`
            );
            clearInterval(interval);
            resolve(true);
            return;
          }
        }
        waitSeconds += retryIntervalSeconds;
        core.info("Waiting for runners...");
      }, retryIntervalSeconds * 1000);
    });
  }
}
