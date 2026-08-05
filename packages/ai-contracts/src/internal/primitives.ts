// Shared Zod primitives used by more than one contract module. INTERNAL ONLY —
// deliberately not re-exported from the barrel, so the package's public surface
// is unchanged.
import { z } from "zod";

export const languageCode = z.string().min(2).max(8);
