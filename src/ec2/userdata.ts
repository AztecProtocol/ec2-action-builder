import { ConfigInterface } from "../config/config";
import * as github from "@actions/github";
import { GithubClient } from "../github/github";

export class UserData {
  config: ConfigInterface;

  constructor(config: ConfigInterface) {
    this.config = config;
  }

  async getUserData(): Promise<string> {
    const ghClient = new GithubClient(this.config);
    const githubActionRunnerVersion = await ghClient.getRunnerVersion();
    // Retrieve runner registration tokens in parallel
    const tokens = await Promise.all(
      Array.from({ length: this.config.githubActionRunnerConcurrency }, () => ghClient.getRunnerRegistrationToken())
    );
    if (!this.config.githubActionRunnerLabel)
      throw Error("failed to object job ID for label");
    const runnerNameBase = `${this.config.githubJobId}-ec2`;
    // Note, we dont make the runner ephemeral as we start fresh runners as needed
    // and delay shutdowns whenever jobs start
    // TODO could deregister runners right before shutdown starts
    const cmds = [
      "#!/bin/bash",
      `shutdown -P +${this.config.ec2InstanceTtl}`,
      "cd /run",
      `echo "shutdown -c ; shutdown -P +${this.config.ec2InstanceTtl}" > /run/delay_shutdown.sh`,
      "chmod +x /run/delay_shutdown.sh",
      "export ACTIONS_RUNNER_HOOK_JOB_STARTED=/run/delay_shutdown.sh",
      "mkdir -p actions-runner && cd actions-runner",
      'echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=/run/delay_shutdown.sh" > .env',
      `GH_RUNNER_VERSION=${githubActionRunnerVersion}`,
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      "curl -O -L https://github.com/actions/runner/releases/download/v${GH_RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${GH_RUNNER_VERSION}.tar.gz",
      "tar xzf ./actions-runner-linux-${RUNNER_ARCH}-${GH_RUNNER_VERSION}.tar.gz",
      "export RUNNER_ALLOW_RUNASROOT=1",
      '[ -n "$(command -v yum)" ] && yum install libicu -y',
      `TOKENS=(${tokens.map((t) => t.token).join(" ")})`,
      `for i in {0..${this.config.githubActionRunnerConcurrency - 1}}; do`,
      `  ( mkdir -p ../${runnerNameBase}-$i && ls -s $(pwd)/* ../${runnerNameBase}-$i && cd ../${runnerNameBase}-$i; ./config.sh --unattended --url https://github.com/${github.context.repo.owner}/${github.context.repo.repo} --token \${TOKENS[i]} --labels ${this.config.githubActionRunnerLabel} --name ${runnerNameBase}-$i ; ./run.sh ) &`,
      "done",
      "wait", // Wait for all background processes to finish
    ];
    console.log("Sending: ", cmds.filter(x => !x.startsWith("TOKENS")).join("\n"));
    return Buffer.from(cmds.join("\n")).toString("base64");
  }
}
