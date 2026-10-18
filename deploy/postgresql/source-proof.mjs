import { createHash } from 'node:crypto';

export function validateTransferProof(bytes, expectedHash, appId) {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash ?? '')) throw new Error('Require --expected-index-sha256 for transfer.json.');
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash.toLowerCase()) throw new Error('Source transfer proof SHA-256 mismatch.');
  const proof = JSON.parse(bytes.toString('utf8'));
  if (!/^[a-f0-9]{64}$/i.test(proof.planHash ?? '') ||
      !/^[a-f0-9]{64}$/i.test(proof.stateDeclarationSHA256 ?? '') ||
      typeof proof.operationId !== 'string' || !proof.operationId.trim() ||
      proof.sourceHost?.toLowerCase() !== 'jimbrownhome' ||
      !proof.fence || !Array.isArray(proof.directories) || !Array.isArray(proof.files) ||
      (proof.appId !== undefined && proof.appId !== appId)) {
    throw new Error('Source transfer proof metadata does not match the reviewed application export.');
  }
  return proof;
}

export function sourceEntry(proof, filename, kinds) {
  const paths = [`data\\${filename}`, `backups\\source\\${filename}`];
  const entries = proof.files.filter(entry => typeof entry.target === 'string' && paths.includes(entry.target.replaceAll('/', '\\')));
  if (entries.length !== 1) throw new Error(`Require exactly one exported source entry for ${filename}.`);
  const entry = entries[0];
  if (!kinds.includes(entry.kind) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? '')) throw new Error(`Invalid source entry proof for ${filename}.`);
  return { ...entry, target: entry.target.replaceAll('/', '\\'), sha256: entry.sha256.toLowerCase() };
}

export function verifySourceBytes(entry, bytes) {
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error('Source file bytes do not match transfer.json.');
  }
}
