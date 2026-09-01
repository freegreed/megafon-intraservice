import test from "node:test";
import assert from "node:assert/strict";

import { extractTaskId, parseHistoryPayload, parseWebhookBody } from "../src/worker.js";

test("parses native MegaFon form-urlencoded history webhook", () => {
  const raw = new URLSearchParams({
    cmd: "history",
    type: "in",
    status: "Success",
    user: "operator-1",
    phone: "79160001122",
    start: "20260901T090000Z",
    duration: "11",
    callid: "call-001",
    link: "https://example.test/record.mp3",
    crm_token: "secret",
  }).toString();

  const payload = parseWebhookBody(raw, "application/x-www-form-urlencoded");
  const result = parseHistoryPayload(payload);

  assert.equal(result.ok, true);
  assert.equal(result.data.status, "RECEIVED");
  assert.equal(result.data.callid, "call-001");
  assert.equal(result.data.record_url, "https://example.test/record.mp3");
  assert.equal(result.data.megafon_user, "operator-1");
});

test("rejects successful incoming calls of 10 seconds or less", () => {
  const result = parseHistoryPayload({
    cmd: "history",
    type: "in",
    status: "Success",
    user: "operator-1",
    duration: "10",
    callid: "call-002",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.status, "SKIPPED");
});

test("skips outgoing calls", () => {
  const result = parseHistoryPayload({
    cmd: "history",
    type: "out",
    status: "Success",
    user: "operator-1",
    duration: "30",
    callid: "call-003",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.status, "SKIPPED");
});

test("accepts JSON as a compatibility input", () => {
  const payload = parseWebhookBody(
    JSON.stringify({
      cmd: "history",
      type: "in",
      status: "success",
      user: "operator-1",
      duration: 11,
      callid: "call-004",
    }),
    "application/json; charset=utf-8",
  );

  assert.equal(parseHistoryPayload(payload).data.status, "RECEIVED");
});

test("extracts task id from JSON and XML responses", () => {
  assert.equal(extractTaskId('{"Id":1234}'), 1234);
  assert.equal(extractTaskId("<Task><Id>5678</Id></Task>"), 5678);
});
