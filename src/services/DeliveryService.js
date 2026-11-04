import axios from "axios";
import { AppError } from "../errors/AppError.js";

// Constantes da loja
// Endereço fixo: Avenida XV de Novembro, 29 — Centro, Cornélio Procópio - PR
// (coordenadas do Google Geocoding, precisão ROOFTOP)
export const STORE_LAT = -23.1786486;
export const STORE_LON = -50.6473325;

// Área de entrega: município de Cornélio Procópio
const AREA_ENTREGA = { sul: -23.375, oeste: -50.8137, norte: -23.014, leste: -50.4648 };
const dentroDaArea = (lat, lon) =>
  lat >= AREA_ENTREGA.sul &&
  lat <= AREA_ENTREGA.norte &&
  lon >= AREA_ENTREGA.oeste &&
  lon <= AREA_ENTREGA.leste;

// Google Geocoding (mesma chave do Clube Kids); sem chave ou se o Google
// recusar, usa o OpenStreetMap/Nominatim.
const chaveGoogle = () =>
  process.env.GOOGLE_GEOCODING_API_KEY || process.env.GOOGLE_GEOLOCATION_API_KEY;
let googleRecusado = false; // chave sem a Geocoding API: usa só o OSM até reiniciar

const FRETE_FIXO = 8.0; // R$ 8,00 para qualquer entrega dentro do raio
const RAIO_MAXIMO_KM = 8; // acima disso (distância de rota) não entregamos

// ─── Helpers ─────────────────────────────────────────────────────────────────
const formatBRL = (valor) =>
  valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/**
 * Executa uma chamada axios com retry automático em caso de falha de rede/timeout.
 * Não retenta erros HTTP 4xx (erros do cliente).
 */
async function axiosWithRetry(config, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await axios(config);
    } catch (err) {
      // Não retenta se for erro HTTP com resposta (4xx/5xx do servidor externo)
      if (err.response) throw err;
      lastErr = err;
      // Aguarda 500ms antes de tentar de novo (exceto na última tentativa)
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  throw lastErr;
}

// Fallback quando o OSRM não responde: distância em linha reta × fator de
// sinuosidade urbana, a uma velocidade média de moto na cidade.
const FATOR_ROTA = 1.4;
const VELOCIDADE_MEDIA_KMH = 25;

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Geocodifica pelo Google. Retorna undefined quando o Google não pode ser usado
 * (sem chave / chave recusada) para cair no OpenStreetMap, e null quando não acha.
 */
async function geocodificarGoogle(texto) {
  const chave = chaveGoogle();
  if (!chave || googleRecusado) return undefined;

  const res = await axiosWithRetry({
    method: "get",
    url: "https://maps.googleapis.com/maps/api/geocode/json",
    params: {
      address: texto,
      region: "br",
      language: "pt-BR",
      components: "country:BR",
      bounds: `${AREA_ENTREGA.sul},${AREA_ENTREGA.oeste}|${AREA_ENTREGA.norte},${AREA_ENTREGA.leste}`,
      key: chave,
    },
    timeout: 10000,
  });
  const dados = res.data;
  if (dados.status === "REQUEST_DENIED") {
    googleRecusado = true;
    console.warn(
      "[Frete] Google recusou a geocodificação (ative a Geocoding API na chave). Usando OpenStreetMap até reiniciar:",
      dados.error_message || "",
    );
    return undefined;
  }
  if (dados.status === "ZERO_RESULTS") return null;
  if (dados.status !== "OK") throw new Error(`Google respondeu ${dados.status}`);

  // Primeiro resultado que cai dentro da área de entrega
  const achou = dados.results.find(({ geometry }) =>
    dentroDaArea(geometry.location.lat, geometry.location.lng),
  );
  if (!achou) return null;
  return {
    lat: achou.geometry.location.lat,
    lon: achou.geometry.location.lng,
    displayName: achou.formatted_address,
  };
}

async function geocodificarOsm(texto) {
  const res = await axiosWithRetry({
    method: "get",
    url: "https://nominatim.openstreetmap.org/search",
    params: {
      q: texto,
      format: "json",
      limit: 1,
      countrycodes: "br",
      viewbox: `${AREA_ENTREGA.oeste},${AREA_ENTREGA.norte},${AREA_ENTREGA.leste},${AREA_ENTREGA.sul}`,
      bounded: 1,
    },
    headers: {
      "User-Agent": "Dubob/1.0 (contato@dubob.com)",
      "Accept-Language": "pt-BR",
    },
    timeout: 15000,
  });
  const [achou] = res.data || [];
  if (!achou) return null;
  return {
    lat: parseFloat(achou.lat),
    lon: parseFloat(achou.lon),
    displayName: achou.display_name,
  };
}

function garantirDentroDoRaio(distanciaKm) {
  if (distanciaKm > RAIO_MAXIMO_KM) {
    throw new AppError(
      `Não entregamos nesse endereço: ele fica a ${distanciaKm.toLocaleString("pt-BR")} km da loja e entregamos até ${RAIO_MAXIMO_KM} km. Você pode escolher retirada no local.`,
      422,
    );
  }
}

// Cache em memória das rotas já calculadas (chave: "lat,lon")
const travelCache = new Map();

// ─── Serviço de Entrega ───────────────────────────────────────────────────────
export class DeliveryService {
  /**
   * Estima o tempo de deslocamento da loja até o destino.
   * Usa OSRM (com cache) e cai para uma estimativa por linha reta se falhar.
   * @returns {Promise<{ distanciaKm: number, tempoEstimado: number } | null>}
   */
  async estimateTravel(lat, lon) {
    if (lat == null || lon == null) return null;

    const key = `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
    if (travelCache.has(key)) return travelCache.get(key);

    let result;
    try {
      const osrmRes = await axios.get(
        `http://router.project-osrm.org/route/v1/driving/${STORE_LON},${STORE_LAT};${lon},${lat}`,
        { params: { overview: "false" }, timeout: 5000 },
      );
      const route = osrmRes.data?.routes?.[0];
      if (osrmRes.data?.code !== "Ok" || !route) throw new Error("no route");

      result = {
        distanciaKm: Math.round((route.distance / 1000) * 10) / 10,
        tempoEstimado: Math.ceil(route.duration / 60),
      };
      travelCache.set(key, result);
    } catch {
      // Não cacheia o fallback para tentar o OSRM de novo na próxima vez
      const km = haversineKm(STORE_LAT, STORE_LON, lat, lon) * FATOR_ROTA;
      result = {
        distanciaKm: Math.round(km * 10) / 10,
        tempoEstimado: Math.max(1, Math.ceil((km / VELOCIDADE_MEDIA_KMH) * 60)),
      };
    }

    return result;
  }

  /**
   * Estima o tempo de uma origem (posição do motoboy) até vários destinos
   * com uma única chamada à API "table" do OSRM.
   * @param {{ lat: number, lon: number }} origin
   * @param {Array<{ lat: number, lon: number }>} destinations
   * @returns {Promise<Array<{ distanciaKm: number, tempoEstimado: number }>>}
   */
  async estimateTravelFrom(origin, destinations) {
    if (destinations.length === 0) return [];

    const fallback = () =>
      destinations.map(({ lat, lon }) => {
        const km = haversineKm(origin.lat, origin.lon, lat, lon) * FATOR_ROTA;
        return {
          distanciaKm: Math.round(km * 10) / 10,
          tempoEstimado: Math.max(
            1,
            Math.ceil((km / VELOCIDADE_MEDIA_KMH) * 60),
          ),
        };
      });

    const coords = [origin, ...destinations]
      .map(({ lat, lon }) => `${lon},${lat}`)
      .join(";");

    try {
      const osrmRes = await axios.get(
        `http://router.project-osrm.org/table/v1/driving/${coords}`,
        {
          params: { sources: 0, annotations: "duration,distance" },
          timeout: 5000,
        },
      );
      const durations = osrmRes.data?.durations?.[0];
      const distances = osrmRes.data?.distances?.[0];
      if (osrmRes.data?.code !== "Ok" || !durations) throw new Error("no table");

      const approx = fallback();
      // Índice 0 é a própria origem
      return destinations.map((_, i) => {
        const duration = durations[i + 1];
        const distance = distances?.[i + 1];
        if (duration == null) return approx[i];
        return {
          distanciaKm:
            distance != null
              ? Math.round((distance / 1000) * 10) / 10
              : approx[i].distanciaKm,
          tempoEstimado: Math.max(1, Math.ceil(duration / 60)),
        };
      });
    } catch {
      return fallback();
    }
  }

  /**
   * Frete de um pedido de entrega, recalculado no servidor a partir das
   * coordenadas do endereço (não confia no valor mandado pelo site).
   * Lança 422 se o endereço estiver fora do raio de entrega.
   * @returns {Promise<{ distanciaKm: number, valorFreteNumerico: number }>}
   */
  async quoteDelivery(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new AppError(
        "Calcule o frete do endereço de entrega antes de finalizar o pedido.",
        422,
      );
    }
    const { distanciaKm } = await this.estimateTravel(lat, lon);
    garantirDentroDoRaio(distanciaKm);
    return { distanciaKm, valorFreteNumerico: FRETE_FIXO };
  }

  /**
   * Calcula o frete com base no CEP, número e cidade do cliente.
   * @param {string} cep    - CEP do cliente (com ou sem traço)
   * @param {string} numero - Número da residência
   * @param {string} cidade - Cidade do cliente
   * @returns {{ distanciaKm: number, valorFrete: string, tempoEstimado: number }}
   */
  async calculateFreight({ cep, numero, cidade, rua }) {
    // ── Etapa 1: Geocodificação (Google, com OpenStreetMap de reserva) ───────
    const cleanCep = cep.replace(/\D/g, "");
    // Usa o nome da rua quando disponível para maior precisão
    const query =
      rua && rua.trim()
        ? `${rua.trim()}, ${numero}, ${cidade}, Brasil`
        : `${cleanCep}, ${numero}, ${cidade}, Brasil`;

    let lat, lon, displayName;

    try {
      let local = await geocodificarGoogle(
        rua && rua.trim()
          ? `${rua.trim()}, ${numero}, ${cidade}, ${cleanCep}, Brasil`
          : query,
      ).catch((err) => {
        console.warn("[Frete] Falha no Google, usando OpenStreetMap:", err.message);
        return undefined;
      });
      if (local === undefined) local = await geocodificarOsm(query);

      if (!local) {
        throw new AppError(
          "Endereço não encontrado. Verifique o CEP, número e cidade informados.",
          422,
        );
      }

      ({ lat, lon, displayName } = local);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        "Falha ao consultar serviço de geocodificação. Tente novamente.",
        502,
      );
    }

    // ── Etapa 2: Cálculo de Rota via OSRM ───────────────────────────────────
    let distanceMeters, durationSeconds;

    try {
      const osrmRes = await axiosWithRetry({
        method: "get",
        url: `http://router.project-osrm.org/route/v1/driving/${STORE_LON},${STORE_LAT};${lon},${lat}`,
        params: { overview: "false" },
        timeout: 15000,
      });

      if (osrmRes.data.code !== "Ok" || !osrmRes.data.routes?.[0]) {
        throw new AppError(
          "Não foi possível calcular a rota para o endereço informado.",
          422,
        );
      }

      distanceMeters = osrmRes.data.routes[0].distance;
      durationSeconds = osrmRes.data.routes[0].duration;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        "Falha ao calcular rota de entrega. Tente novamente.",
        502,
      );
    }

    // ── Etapa 3: Cálculo do Frete ────────────────────────────────────────────
    const distanciaKm = Math.round((distanceMeters / 1000) * 10) / 10;
    garantirDentroDoRaio(distanciaKm);
    const valorFreteNumerico = FRETE_FIXO;
    const tempoEstimado = Math.ceil(durationSeconds / 60);

    return {
      lat,
      lon,
      displayName,
      distanciaKm,
      valorFrete: formatBRL(valorFreteNumerico),
      valorFreteNumerico: Math.round(valorFreteNumerico * 100) / 100,
      tempoEstimado,
    };
  }
}
