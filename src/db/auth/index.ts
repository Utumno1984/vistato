/** Authentication data layer (cross-tenant by nature: see the header of each module). */
export { verifyCredentials, type AuthenticatedUser } from "./credentials";
export { createSession, deleteSession, deleteUserSessions, resolveSession, SESSION_DURATION_MS, type ResolvedSession } from "./sessions";
