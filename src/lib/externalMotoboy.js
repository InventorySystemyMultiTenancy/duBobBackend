// "Motoboy de fora": entregador que não é da loja. Fica gravado no lugar do id
// do motoboy; não tem localização nem confirma a entrega (o pedido finaliza
// assim que sai).
export const EXTERNAL_MOTOBOY_ID = "EXTERNO";

export const isExternalMotoboy = (motoboyId) => motoboyId === EXTERNAL_MOTOBOY_ID;
