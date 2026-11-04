import { generateKeyPairSync, createPrivateKey, sign, verify } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export type KeyPaths = { privatePath: string; publicPath: string };

export async function createTestKeys(outputDir: string): Promise<KeyPaths> {
  const dir = resolve(outputDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const privatePath = join(dir, 'private.pem');
  const publicPath = join(dir, 'public.pem');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  // wx: never silently overwrite a test key that may already be trusted by an application.
  await writeFile(privatePath, priv, { mode: 0o600, flag: 'wx' });
  try {
    await writeFile(publicPath, pub, { mode: 0o644, flag: 'wx' });
  } catch (err) {
    // Roll back only our freshly created private key on a partial failure.
    await unlink(privatePath);
    throw err;
  }
  await chmod(privatePath, 0o600);
  return { privatePath, publicPath };
}

export async function signBytes(raw: Buffer, privateKeyFile: string): Promise<string> {
  const privateKey = createPrivateKey(await readFile(resolve(privateKeyFile)));
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Expected an EC P-256 (prime256v1) test private key');
  }
  return sign('sha256', raw, privateKey).toString('base64');
}

export async function verifyBytes(raw: Buffer, signatureB64: string, publicKeyFile: string): Promise<boolean> {
  return verify('sha256', raw, await readFile(resolve(publicKeyFile)), Buffer.from(signatureB64, 'base64'));
}
