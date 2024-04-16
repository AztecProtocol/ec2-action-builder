import { ActionConfig } from "./config/config";
import { Ec2Instance } from "./ec2/ec2";
import * as core from "@actions/core";
import { GithubClient } from "./github/github";
import { assertIsError } from "./utils/utils";
import { assert } from "console";

async function start() {
  const config = new ActionConfig();
  if (config.subaction === "stop") {
    await stop();
    return;
  } else if (config.subaction === "restart") {
    await stop();
    // then we make a fresh instance
  } else if (config.subaction !== "start") {
    throw new Error("Unexpected subaction: " + config.subaction);
  }
  // assume subaction is 'start'
  const ec2Client = new Ec2Instance(config);
  const ghClient = new GithubClient(config);

  var ec2SpotStrategies: string[];
  switch (config.ec2SpotInstanceStrategy) {
    case "maxperformance": {
      ec2SpotStrategies = ["MaxPerformance", "SpotOnly"];
      core.info(
        "Ec2 spot instance strategy is set to 'MaxPerformance' with 'SpotOnly' and 'None' as fallback"
      );
      break;
    }
    case "besteffort": {
      ec2SpotStrategies = ["BestEffort", "none"];
      core.info(
        "Ec2 spot instance strategy is set to 'BestEffort' with 'None' as fallback"
      );
      break;
    }
    default: {
      ec2SpotStrategies = [config.ec2SpotInstanceStrategy];
      core.info(
        `Ec2 spot instance strategy is set to ${config.ec2SpotInstanceStrategy}`
      );
    }
  }

  const instances = await ec2Client.getInstancesForTags();
  const hasInstance =
    instances.filter((i) => i.State?.Name === "running").length > 0;
  if (hasInstance) {
    core.info(
      `Runner already running. Continuing as we can target it with jobs.`
    );
    await ghClient.pollForRunnerCreation([config.githubJobId]);
    return;
  }
  var instanceId = "";
  for (const ec2Strategy of ec2SpotStrategies) {
    core.info(`Starting instance with ${ec2Strategy} strategy`);
    // Get instance config
    const instanceConfig = await ec2Client.getInstanceConfiguration(
      ec2Strategy
    );
    try {
      // Start instance
      const response = await ec2Client.runInstances(instanceConfig);
      if (response?.length && response.length > 0 && response[0].InstanceId) {
        instanceId = response[0].InstanceId;
        break;
      }
    } catch (error) {
      if (
        error?.code &&
        error.code === "InsufficientInstanceCapacity" &&
        ec2SpotStrategies.length > 0 &&
        ec2Strategy.toLocaleUpperCase() != "none"
      )
        core.info(
          "Failed to create instance due to 'InsufficientInstanceCapacity', trying fallback strategy next"
        );
      else throw error;
    }
  }
  if (instanceId) await ec2Client.waitForInstanceRunningStatus(instanceId);
  else {
    core.error("Failed to get ID of running instance");
    throw Error("Failed to get ID of running instance");
  }
  if (instanceId) await ghClient.pollForRunnerCreation([config.githubJobId]);
  else {
    core.error("Instance failed to register with Github Actions");
    throw Error("Instance failed to register with Github Actions");
  }
}

async function stop() {
  try {
    core.info("Starting instance cleanup");
    const config = new ActionConfig();
    const ec2Client = new Ec2Instance(config);
    const ghClient = new GithubClient(config);
    const instances = await ec2Client.getInstancesForTags();
    await ec2Client.terminateInstances(instances.map((i) => i.InstanceId!));
    core.info("Clearing previously installed runners");
    const result = await ghClient.removeRunnersWithLabels([config.githubJobId]);
    if (result) {
      core.info("Finished runner cleanup");
    } else {
      throw Error(
        "Failed to cleanup runners. Continuing, but failure expected!"
      );
    }
  } catch (error) {
    core.info(error);
  }
}

(async function () {
  try {
    start();
  } catch (error) {
    stop();
    assertIsError(error);
    core.error(error);
    core.setFailed(error.message);
  }
})();
