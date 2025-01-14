import { CurrentsRunParameters, SummaryResults } from "../types";
import { getCapturedOutput, resetCapture } from "./capture";
import { ResolvedConfig } from "./config";
import { getSummaryForSpec, normalizeRawResult } from "./results";

import Debug from "debug";
import { createBatchedInstances, createInstance } from "./api/api";
import {
  CreateInstancePayload,
  InstanceResponseSpecDetails,
} from "./api/types/instance";
import { runSpecFileSafe } from "./cypress";
import { isCurrents } from "./env";
import { divider, error, info, title, warn } from "./log";
import { getUploadResultsTask } from "./results/uploadResults";

const debug = Debug("currents:runner");

export async function runTillDone(
  {
    runId,
    groupId,
    machineId,
    platform,
    config,
  }: CreateInstancePayload & {
    config: ResolvedConfig;
  },
  params: CurrentsRunParameters
) {
  const summary: SummaryResults = {};
  const uploadTasks: Promise<any>[] = [];
  let hasMore = true;

  while (hasMore) {
    const newTasks = await runBatch({
      runMeta: {
        runId,
        groupId,
        machineId,
        platform,
      },
      params,
      config,
    });
    if (!newTasks.length) {
      debug("No more tasks to run. Uploads queue: %d", uploadTasks.length);
      hasMore = false;
      break;
    }
    newTasks.forEach((task) => {
      if (task.summary.specSummary) {
        summary[task.summary.spec] = task.summary.specSummary;
      }
      uploadTasks.push(task.uploadTasks);
    });
  }

  await Promise.allSettled(uploadTasks);
  return summary;
}

async function runBatch({
  runMeta,
  config,
  params,
}: {
  runMeta: {
    runId: string;
    groupId: string;
    machineId: string;
    platform: CreateInstancePayload["platform"];
  };
  config: ResolvedConfig;
  params: CurrentsRunParameters;
}) {
  let batch = {
    specs: [] as InstanceResponseSpecDetails[],
    claimedInstances: 0,
    totalInstances: 0,
  };

  if (isCurrents() || !!process.env.CURRENTS_BATCHED_ORCHESTRATION) {
    debug("Getting batched tasks: %d", params.batchSize);
    batch = await createBatchedInstances({
      ...runMeta,
      batchSize: params.batchSize,
    });
  } else {
    const response = await createInstance(runMeta);

    if (response.spec !== null && response.instanceId !== null) {
      batch.specs.push({
        spec: response.spec,
        instanceId: response.instanceId,
      });
    }
    batch.claimedInstances = response.claimedInstances;
    batch.totalInstances = response.totalInstances;
  }

  if (batch.specs.length === 0) {
    return [];
  }

  divider();
  info(
    "Running: %s (%d/%d)",
    batch.specs.map((s) => s.spec).join(", "),
    batch.claimedInstances,
    batch.totalInstances
  );

  const rawResult = await runSpecFileSafe(
    { spec: batch.specs.map((s) => s.spec).join(",") },
    params
  );
  const normalizedResult = normalizeRawResult(
    rawResult,
    batch.specs.map((s) => s.spec),
    config
  );

  title("blue", "Reporting results and artifacts in background...");

  const output = getCapturedOutput();
  resetCapture();

  const batchResult = batch.specs.map((spec) => {
    const specSummary = getSummaryForSpec(spec.spec, normalizedResult);
    if (!specSummary) {
      warn('Cannot find run result for spec "%s"', spec.spec);
    }

    return {
      summary: {
        spec: spec.spec,
        specSummary,
      },
      uploadTasks: getUploadResultsTask({
        ...spec,
        runResult: normalizedResult,
        output,
      }).catch(error),
    };
  });

  return batchResult;
}
