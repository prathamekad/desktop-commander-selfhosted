import assert from 'node:assert/strict';
import {
  assertRemoteToolPolicy,
  isRemoteToolVisible,
  pathAllowed,
  wrapPowerShellCommand
} from '../dist/selfhost/policy.js';

const roots = ['D:\\AI-Lab'];
const readOnlyRoots = ['C:\\Users\\Prathamesh\\AppData\\Local\\hermes'];

assert.equal(pathAllowed('D:\\AI-Lab', roots), true);
assert.equal(pathAllowed('D:\\AI-Lab\\project\\file.txt', roots), true);
assert.equal(pathAllowed('D:\\Other\\file.txt', roots), false);
assert.equal(pathAllowed('C:\\Users\\Prathamesh\\secret.txt', roots), false);
assert.equal(pathAllowed('..\\secret.txt', roots), false);

assert.equal(isRemoteToolVisible('set_config_value'), false);
assert.equal(isRemoteToolVisible('give_feedback_to_desktop_commander'), false);
assert.equal(isRemoteToolVisible('read_file'), true);

assert.doesNotThrow(() => {
  assertRemoteToolPolicy('read_file', { path: 'D:\\AI-Lab\\project\\file.txt' }, roots, readOnlyRoots);
});

assert.doesNotThrow(() => {
  assertRemoteToolPolicy(
    'read_file',
    { path: 'C:\\Users\\Prathamesh\\AppData\\Local\\hermes\\state.json' },
    roots,
    readOnlyRoots
  );
});

assert.doesNotThrow(() => {
  assertRemoteToolPolicy(
    'list_directory',
    { path: 'C:\\Users\\Prathamesh\\AppData\\Local\\hermes' },
    roots,
    readOnlyRoots
  );
});

assert.throws(() => {
  assertRemoteToolPolicy(
    'write_file',
    { path: 'C:\\Users\\Prathamesh\\AppData\\Local\\hermes\\state.json' },
    roots,
    readOnlyRoots
  );
}, /outside the approved remote writable roots/i);

assert.throws(() => {
  assertRemoteToolPolicy(
    'edit_block',
    { file_path: 'C:\\Users\\Prathamesh\\AppData\\Local\\hermes\\state.json' },
    roots,
    readOnlyRoots
  );
}, /outside the approved remote writable roots/i);

assert.throws(() => {
  assertRemoteToolPolicy('read_file', { path: 'C:\\Users\\Prathamesh\\secret.txt' }, roots, readOnlyRoots);
}, /outside the approved remote read roots/i);

assert.throws(() => {
  assertRemoteToolPolicy('read_file', { path: 'https://example.com', isUrl: true }, roots);
}, /URL fetching/i);

assert.throws(() => {
  assertRemoteToolPolicy('set_config_value', { key: 'allowedDirectories', value: [] }, roots);
}, /disabled for remote connectors/i);

assert.throws(() => {
  assertRemoteToolPolicy('start_process', { command: 'node:local', timeout_ms: 1000 }, roots);
}, /node:local is disabled/i);

assert.throws(() => {
  assertRemoteToolPolicy('start_process', { command: 'type C:\\Windows\\win.ini', timeout_ms: 1000 }, roots, readOnlyRoots);
}, /outside approved roots/i);

assert.throws(() => {
  assertRemoteToolPolicy(
    'start_process',
    { command: 'shutdown /s /t 60', timeout_ms: 1000 },
    roots,
    readOnlyRoots
  );
}, /system-management command|outside approved roots/i);

assert.throws(() => {
  assertRemoteToolPolicy('start_process', { command: 'Get-Content ..\\secret.txt', timeout_ms: 1000 }, roots);
}, /parent-directory traversal/i);

assert.throws(() => {
  assertRemoteToolPolicy('start_process', { command: 'Invoke-Expression $x', timeout_ms: 1000 }, roots);
}, /dynamic PowerShell evaluation/i);

assert.doesNotThrow(() => {
  assertRemoteToolPolicy('start_process', { command: 'npm test', timeout_ms: 1000 }, roots);
});

const wrapped = wrapPowerShellCommand('npm test', roots);
assert.match(wrapped, /^Set-Location -LiteralPath 'D:\\AI-Lab'; npm test$/);

console.log('selfhost policy: PASS');
