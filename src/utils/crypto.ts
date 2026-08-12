import { config, DEFAULT_ENCRYPTION_KEY_VALUE } from "../config";

const VERSION_AES_GCM = 0x01;
const IV_LENGTH = 12;

async function deriveKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(config.encryptionKey));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encrypt(plaintext: string): Promise<string> {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const payload = new Uint8Array(1 + IV_LENGTH + ciphertext.length);
  payload[0] = VERSION_AES_GCM;
  payload.set(iv, 1);
  payload.set(ciphertext, 1 + IV_LENGTH);
  return toBase64(payload);
}

export async function decrypt(ciphertext: string): Promise<string> {
  const data = fromBase64(ciphertext);
  if (data.length < 1 + IV_LENGTH || data[0] !== VERSION_AES_GCM) {
    throw new Error("Unsupported ciphertext format");
  }
  const iv = data.slice(1, 1 + IV_LENGTH);
  const encrypted = data.slice(1 + IV_LENGTH);
  const key = await deriveKey();
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  return new TextDecoder().decode(plaintext);
}

export function isDefaultEncryptionKey(): boolean {
  return config.encryptionKey === DEFAULT_ENCRYPTION_KEY_VALUE;
}
