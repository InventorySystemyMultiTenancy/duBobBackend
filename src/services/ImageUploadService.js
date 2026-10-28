import crypto from "node:crypto";
import { AppError } from "../errors/AppError.js";

// Aceita CLOUDINARY_URL (cloudinary://key:secret@cloud) ou as três variáveis separadas.
function readCloudinaryConfig() {
  const url = process.env.CLOUDINARY_URL;
  if (url) {
    const match = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(url.trim());
    if (match) {
      return { apiKey: match[1], apiSecret: match[2], cloudName: match[3] };
    }
  }
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  };
}

export class ImageUploadService {
  // Gera a assinatura para o navegador enviar a imagem direto ao Cloudinary,
  // sem expor o API secret e sem passar o arquivo pelo nosso servidor.
  createProductUploadSignature() {
    const { cloudName, apiKey, apiSecret } = readCloudinaryConfig();
    if (!cloudName || !apiKey || !apiSecret) {
      throw new AppError("Upload de imagem não configurado (Cloudinary).", 503);
    }

    const folder = process.env.CLOUDINARY_FOLDER || "dubob/products";
    const timestamp = Math.floor(Date.now() / 1000);
    const toSign = `folder=${folder}&timestamp=${timestamp}`;
    const signature = crypto
      .createHash("sha1")
      .update(toSign + apiSecret)
      .digest("hex");

    return {
      cloudName,
      apiKey,
      folder,
      timestamp,
      signature,
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    };
  }
}
