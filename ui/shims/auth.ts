// The browser demo has no passwords: you pick who you are acting as. Permissions are still enforced by the engine.
export const hashPassword = async (_pw: string): Promise<string> => 'demo$no-login';
