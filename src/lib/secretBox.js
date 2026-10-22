import crypto from "crypto";

// Criptografia simétrica (AES-256-GCM) para segredos guardados no banco,
// como a senha do usuário SumUp de cada maquininha.
const getKey = () =>
  crypto
    .createHash("sha256")
    .update(process.env.CREDENTIALS_SECRET || process.env.JWT_SECRET || "")
    .digest();

export const encryptSecret = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
};

export const decryptSecret = (encoded) => {
  const [iv, tag, data] = String(encoded).split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
};
