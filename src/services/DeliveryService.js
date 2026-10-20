import axios from "axios";
import { AppError } from "../errors/AppError.js";

// Constantes da loja
// Endereço fixo: Avenida Cachoeira Paulista, 17 — CEP 03551-000, São Paulo
export const STORE_LAT = -23.5318;
export const STORE_LON = -46.5043;

const TAXA_BASE = 5.0; // R$ 5,00 fixo (saída do motoboy)
const TAXA_POR_KM = 2.0; // R$ 2,00 por km rodado

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
   * Calcula o frete com base no CEP, número e cidade do cliente.
   * @param {string} cep    - CEP do cliente (com ou sem traço)
   * @param {string} numero - Número da residência
   * @param {string} cidade - Cidade do cliente
   * @returns {{ distanciaKm: number, valorFrete: string, tempoEstimado: number }}
   */
  async calculateFreight({ cep, numero, cidade, rua }) {
    // ── Etapa 1: Geocodificação via Nominatim ────────────────────────────────
    const cleanCep = cep.replace(/\D/g, "");
    // Usa o nome da rua quando disponível para maior precisão
    const query =
      rua && rua.trim()
        ? `${rua.trim()}, ${numero}, ${cidade}, Brasil`
        : `${cleanCep}, ${numero}, ${cidade}, Brasil`;

    let lat, lon, displayName;

    try {
      const nominatimRes = await axiosWithRetry({
        method: "get",
        url: "https://nominatim.openstreetmap.org/search",
        params: {
          q: query,
          format: "json",
          limit: 1,
          countrycodes: "br",
          // Restringe ao município de São Paulo (bounding box)
          viewbox: "-46.8254,-23.3568,-46.3648,-24.0085",
          bounded: 1,
        },
        headers: {
          "User-Agent": "Dubob/1.0 (contato@dubob.com)",
          "Accept-Language": "pt-BR",
        },
        timeout: 15000,
      });

      if (!nominatimRes.data || nominatimRes.data.length === 0) {
        throw new AppError(
          "Endereço não encontrado. Verifique o CEP, número e cidade informados.",
          422,
        );
      }

      lat = parseFloat(nominatimRes.data[0].lat);
      lon = parseFloat(nominatimRes.data[0].lon);
      displayName = nominatimRes.data[0].display_name;
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
    const valorFreteNumerico = TAXA_BASE + distanciaKm * TAXA_POR_KM;
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
