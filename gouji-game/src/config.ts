/**
 * Online server configuration.
 *
 * GAME_WS_URL must match the `websockets.game.url` in manifest.json.
 * It is a placeholder until the game server is deployed: replace it with
 * the deployed WSS address (and the same address in manifest.json).
 */
export const GAME_WS_URL = "wss://api.example.com/gouji";
export const GAME_WS_PLACEHOLDER = "wss://api.example.com/gouji";
export const SERVER_CONFIGURED = GAME_WS_URL !== GAME_WS_PLACEHOLDER;
