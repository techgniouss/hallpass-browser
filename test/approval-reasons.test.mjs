// A missing approval must say WHY: only a real Deny means "do not retry". A timeout / no dialog is not a refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.HALLPASS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-reasons-'));
const ui = await import('../src/ui.mjs');
const { isRiskyLabel, gateGrantKey } = await import('../src/act.mjs');

test('ask() with the UI disabled reports no_ui, not denied', () => {
  process.env.HALLPASS_NO_UI = '1';
  try {
    assert.equal(ui.ask({ title: 't', message: 'm', buttons: [{ id: 'deny', label: 'Deny' }, { id: 'once', label: 'Allow' }] }), null);
    assert.equal(ui.lastOutcome().reason, 'no_ui');
    assert.match(ui.explainNoApproval('action'), /no desktop dialog could be shown/);
    assert.doesNotMatch(ui.explainNoApproval('action'), /Do not retry/);
  } finally { delete process.env.HALLPASS_NO_UI; }
});

test('explainNoApproval: only an explicit Deny tells the agent not to retry', () => {
  ui.resetOutcome();
  assert.match(ui.explainNoApproval('action'), /clicked Deny[\s\S]*Do not retry/);
});

test('approval timeout is shorter for MCP than the CLI wait but long enough to notice a dialog', () => {
  const was = process.env.HALLPASS_ACTOR;
  try {
    delete process.env.HALLPASS_ACTOR; assert.equal(ui.approvalTimeoutSec(), 120);
    process.env.HALLPASS_ACTOR = 'mcp'; assert.equal(ui.approvalTimeoutSec(), 90);
  } finally { if (was === undefined) delete process.env.HALLPASS_ACTOR; else process.env.HALLPASS_ACTOR = was; }
});

test('classifier: opening a release or a CI row is not gated, publishing still is', () => {
  for (const l of ['manage release 18 (1.3.8)', 'rocket_launch test and release', 'release\\n4m 23s', 'create new release', 'release notes']) assert.ok(!isRiskyLabel(l), 'should NOT be risky: ' + l);
  for (const l of ['Publish release', 'Start rollout', 'Send changes for review', 'submit 1 change for review', 'Discard release', 'delete remove 1.jpeg']) assert.ok(isRiskyLabel(l), 'should be risky: ' + l);
});

test('1-hour click grants are keyed by a real origin; no origin means no grant', () => {
  assert.equal(gateGrantKey('hp-a', ''), null);
  assert.equal(gateGrantKey('hp-a', 'not a url'), null);
  assert.equal(gateGrantKey('hp-a', 'https://play.google.com/console/x'), gateGrantKey('hp-a', 'https://play.google.com/other'));
  assert.notEqual(gateGrantKey('hp-a', 'https://play.google.com/x'), gateGrantKey('hp-b', 'https://play.google.com/x'), 'per session');
  assert.notEqual(gateGrantKey('hp-a', 'https://play.google.com/x'), gateGrantKey('hp-a', 'https://evil.example/x'), 'per origin');
});
