let cachedModule = null;

export async function resolveBaileysModule() {
    if (cachedModule) return cachedModule;
    cachedModule = await import('../../index.js');
    return cachedModule;
}
