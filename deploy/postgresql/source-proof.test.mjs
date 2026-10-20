import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { sourceEntry, validateTransferProof, verifySourceBytes } from './source-proof.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const data = Buffer.from('synthetic fixture only');
const makeProof = (overrides) => ({
    planHash: 'a'.repeat(64),
    stateDeclarationSHA256: 'b'.repeat(64),
    operationId: 'test-export',
    sourceHost: 'jimbrownhome',
    fence: { stopped: true },
    directories: [],
    files: [{ target: 'backups\\source\\ferry-capture.db', kind: 'sqlite', bytes: data.length, sha256: sha(data) }],
    ...overrides,
});
const validate = (proof) => {
    const bytes = Buffer.from(JSON.stringify(proof));
    return validateTransferProof(bytes, sha(bytes), 'ferry-tracker');
};

test('transfer proof binds exact bytes, metadata and source target without database access', () => {
    const proof = validate(makeProof());
    const entry = sourceEntry(proof, 'ferry-capture.db', ['sqlite']);
    verifySourceBytes(entry, data);
    assert.throws(() => verifySourceBytes(entry, Buffer.from('changed')), /do not match/);
    assert.throws(() => validateTransferProof(Buffer.from('{}'), 'c'.repeat(64), 'ferry-tracker'), /SHA-256 mismatch/);
    assert.throws(() => validate(makeProof({ sourceHost: 'another-host' })), /metadata/);
    assert.throws(() => validate(makeProof({ appId: 'site-dock' })), /metadata/);
    assert.throws(() => validate(makeProof({ fence: null })), /metadata/);
    assert.throws(
        () =>
            sourceEntry(makeProof({ files: [{ ...entry, target: '..\\ferry-capture.db' }] }), 'ferry-capture.db', [
                'sqlite',
            ]),
        /exactly one/
    );
    assert.throws(
        () => sourceEntry(makeProof({ files: [entry, entry] }), 'ferry-capture.db', ['sqlite']),
        /exactly one/
    );
    assert.throws(
        () => sourceEntry(makeProof({ files: [{ ...entry, kind: 'file' }] }), 'ferry-capture.db', ['sqlite']),
        /Invalid/
    );
});
