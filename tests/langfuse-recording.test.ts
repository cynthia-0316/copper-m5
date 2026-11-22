// How an evaluation is recorded in, and read back from, Langfuse. The four A/B
// runs found that the neutral dataset's items never existed: dataset item ids
// are unique across the whole project, so creating them under the case ids that
// the original dataset already holds answered HTTP 409, the experiment never
// ran, and the read-back (which also hit Langfuse's rate limit) reported
// nothing useful. These tests use fakes: no keys, no network.
import { describe, expect, it, vi } from "vitest";
import type { CaseResult } from "@/evals/evaluate";
import { GOLDEN_SET } from "@/evals/golden-set";
import {
  DATASET_NAME,
  datasetItemId,
  type LangfuseRun,
  readBack,
  syncDataset,
} from "@/evals/langfuse";
import { describeCheck, verifyRun } from "@/evals/langfuse-verify";
import { NEUTRAL_SET, NEUTRAL_VERSION } from "@/evals/neutral";
import { allPages, LangfuseHttpError, politeGetter } from "@/evals/polite";

describe("dataset items", () => {
  it("keeps the plain case id in the original dataset and prefixes any other dataset", () => {
    expect(datasetItemId(DATASET_NAME, "refund-over-limit")).toBe(
      "refund-over-limit",
    );
    expect(
      datasetItemId("copper-golden-set-neutral", "refund-over-limit"),
    ).toBe("copper-golden-set-neutral:refund-over-limit");
  });

  it("syncs both datasets without any item id appearing twice, and keeps the case id in metadata", async () => {
    const created: {
      datasetName: string;
      id: string;
      metadata: { caseId: string };
    }[] = [];
    const lf = {
      client: {
        api: {
          datasets: { create: vi.fn(async () => ({})) },
          datasetItems: {
            create: vi.fn(async (item: (typeof created)[number]) => {
              created.push(item);
              return {};
            }),
          },
        },
      },
      problems: [],
    } as unknown as LangfuseRun;
    await syncDataset(lf, "rubric-v1");
    await syncDataset(
      lf,
      "rubric-v1",
      NEUTRAL_SET,
      "copper-golden-set-neutral",
      NEUTRAL_VERSION,
    );
    expect(created).toHaveLength(GOLDEN_SET.length * 2);
    const ids = created.map((c) => c.id);
    // Ids are unique project-wide: this is what Langfuse enforces (HTTP 409).
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of created)
      expect(GOLDEN_SET.map((c) => c.id)).toContain(item.metadata.caseId);
    expect(
      created.filter((c) => c.datasetName === "copper-golden-set-neutral"),
    ).toHaveLength(GOLDEN_SET.length);
  });
});

describe("the polite Langfuse reader", () => {
  const reply = (status: number, body: unknown) => ({
    status,
    text: async () => JSON.stringify(body),
  });

  it("keeps a gap between requests so it stays under 30 a minute", async () => {
    let clock = 0;
    const starts: number[] = [];
    const get = politeGetter({
      send: async () => {
        starts.push(clock);
        return reply(200, { data: [] });
      },
      gapMs: 2600,
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
    });
    for (let i = 0; i < 5; i++) await get("/api/public/x");
    for (let i = 1; i < starts.length; i++)
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(2600);
    // Never more than 30 in any minute.
    for (const t of starts)
      expect(
        starts.filter((s) => s >= t && s < t + 60_000).length,
      ).toBeLessThanOrEqual(24);
  });

  it("waits out a 429 for as long as Langfuse says, then answers", async () => {
    let clock = 0;
    const waits: number[] = [];
    const send = vi
      .fn()
      .mockResolvedValueOnce(
        reply(429, {
          message: "Rate limit exceeded",
          details: { retryAfterSeconds: 41 },
        }),
      )
      .mockResolvedValue(reply(200, { data: [{ name: "ok" }] }));
    const get = politeGetter({
      send,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    expect(await get("/api/public/x")).toEqual({ data: [{ name: "ok" }] });
    expect(waits).toContain(42_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not hide an HTTP 400: it throws with the status and the body", async () => {
    const get = politeGetter({
      send: async () => reply(400, { message: "Invalid request data" }),
      sleep: async () => {},
    });
    await expect(
      get("/api/public/experiment-items?limit=200"),
    ).rejects.toMatchObject({
      name: "LangfuseHttpError",
      status: 400,
    });
    await expect(get("/api/public/x")).rejects.toThrow(/Invalid request data/);
  });

  it("follows the cursor through every page", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: [1, 2], meta: { cursor: "c1" } })
      .mockResolvedValueOnce({ data: [3] });
    expect(await allPages<number>(get, "/p?limit=2")).toEqual([1, 2, 3]);
    expect(get.mock.calls[1][0]).toContain("cursor=c1");
  });
});

describe("the read-back", () => {
  const traceIds = ["t1", "t2"];
  const rows = (path: string) =>
    path.includes("experiment-items")
      ? {
          data: [
            { experimentName: "RUN", traceId: "t1" },
            { experimentName: "RUN", traceId: "t2" },
            { experimentName: "OTHER", traceId: "t1" },
          ],
        }
      : {
          data: [
            { name: "case_pass", subject: { traceId: "t1" } },
            { name: "case_pass", subject: { traceId: "t2" } },
            { name: "x", subject: { traceId: "stranger" } },
          ],
        };

  it("counts this run's items and scores and ignores other runs and other traces", async () => {
    const found = await readBack(
      "RUN",
      traceIds,
      { items: 2, scores: 2 },
      { since: new Date().toISOString(), waitMs: 0, get: async (p) => rows(p) },
    );
    expect(found).toEqual({ items: 2, scores: 2 });
  });

  it("says the data is MISSING when the query worked and found fewer", async () => {
    const found = await readBack(
      "RUN",
      traceIds,
      { items: 2, scores: 4 },
      { since: new Date().toISOString(), waitMs: 0, get: async (p) => rows(p) },
    );
    expect(found.scores).toBe(2);
    expect(found.error).toBeUndefined();
  });

  it("says the QUERY FAILED, not that data is missing, when Langfuse answers an error", async () => {
    const found = await readBack(
      "RUN",
      traceIds,
      { items: 2, scores: 2 },
      {
        since: new Date().toISOString(),
        waitMs: 0,
        get: async (path) => {
          throw new LangfuseHttpError(
            429,
            path,
            '{"message":"Rate limit exceeded"}',
          );
        },
      },
    );
    expect(found.error).toMatch(/429/);
    expect(found).toMatchObject({ items: 0, scores: 0 });
  });
});

describe("verifying a saved run against Langfuse", () => {
  const result = (caseId: string, traceId: string): CaseResult => ({
    caseId,
    title: "",
    category: "",
    critical: false,
    status: "passed",
    criticalFailure: false,
    failures: [],
    attempts: 1,
    checks: [],
    turns: [],
    finalTraceId: traceId,
    activity: { toolCalls: 1, toolErrors: 0, handoffs: 0, rateLimitWaitMs: 0 },
    candidate: {
      modelCalls: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.001,
      latencyMs: 1,
    },
  });
  const saved = {
    info: {
      runId: "RUN",
      commit: "ce68fd1",
      agentMode: "single" as const,
      goldenSetVersion: NEUTRAL_VERSION,
      rubricVersion: "rubric-v1",
      candidateModel: "m",
      judgeModel: "m",
      startedAt: "2026-11-22T06:00:00Z",
      finishedAt: "2026-11-22T06:10:00Z",
      langfuse: { enabled: true, complete: false, detail: "" },
    },
    results: [result("a", "t1"), result("b", "t2")],
  };

  it("reports traces present but experiment, items and scores MISSING when the queries worked and found none", async () => {
    const get = async (path: string) => {
      if (path.includes("name=ask-copper-turn"))
        return {
          data: [
            { traceId: "t1", metadata: { runId: "RUN" } },
            { traceId: "t2", metadata: { runId: "RUN" } },
          ],
        };
      return { data: [] };
    };
    const v = await verifyRun(saved, get);
    expect(v.traces).toEqual({ state: "ok", found: 2, expected: 2 });
    expect(v.experiment.state).toBe("missing");
    expect(v.experimentItems).toMatchObject({
      state: "missing",
      found: 0,
      expected: 2,
    });
    expect(v.scores).toMatchObject({ state: "missing", found: 0 });
    expect(Object.keys(v.scoreShortfall ?? {})).toContain("exec_model_calls");
    expect(describeCheck(v.experiment)).toContain("MISSING");
  });

  it("reports QUERY FAILED, never 'missing', when the API refuses the question", async () => {
    const get = async (path: string) => {
      throw new LangfuseHttpError(429, path, "rate limited");
    };
    const v = await verifyRun(saved, get);
    for (const check of [v.traces, v.experiment, v.experimentItems, v.scores]) {
      expect(check.state).toBe("query_failed");
      expect(describeCheck(check)).toContain("QUERY FAILED");
    }
  });

  it("reports everything ok when it is all there", async () => {
    const names = [
      "exec_model_calls",
      "exec_input_tokens",
      "exec_output_tokens",
      "exec_cost_usd",
      "exec_latency_ms",
      "exec_tool_calls",
      "exec_tool_errors",
      "exec_handoffs",
      "deterministic_pass",
      "case_pass",
    ];
    const get = async (path: string) => {
      if (path.includes("name=ask-copper-turn"))
        return {
          data: [
            { traceId: "t1", metadata: { runId: "RUN" } },
            { traceId: "t2", metadata: { runId: "RUN" } },
          ],
        };
      if (path.includes("/experiments?")) return { data: [{ name: "RUN" }] };
      if (path.includes("experiment-items"))
        return {
          data: [
            { experimentName: "RUN", traceId: "t1" },
            { experimentName: "RUN", traceId: "t2" },
          ],
        };
      return {
        data: ["t1", "t2"].flatMap((t) =>
          names.map((name) => ({ name, subject: { traceId: t } })),
        ),
      };
    };
    const v = await verifyRun(saved, get);
    expect(v.traces.state).toBe("ok");
    expect(v.experiment.state).toBe("ok");
    expect(v.experimentItems.state).toBe("ok");
    expect(v.scores).toMatchObject({ state: "ok", found: 20, expected: 20 });
  });
});
