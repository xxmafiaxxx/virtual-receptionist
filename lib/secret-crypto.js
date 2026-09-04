import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function encryptionKey() {
  const value = process.env.APP_ENCRYPTION_KEY
  if (!value) throw new Error('APP_ENCRYPTION_KEY is not configured')
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 random bytes encoded as base64')
  return key
}

export function encryptSecret(value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return {
    algorithm: 'aes-256-gcm',
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

export function decryptSecret(value) {
  if (!value?.ciphertext || !value?.iv || !value?.tag) return null
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
