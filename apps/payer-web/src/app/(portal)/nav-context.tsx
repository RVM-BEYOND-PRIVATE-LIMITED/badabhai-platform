"use client";

import { createContext, useContext } from "react";
import type { NavSection } from "./nav-model";

/**
 * The portal's nav sections, as the shell received them from the server (the SAME model the
 * rail and the header trail render), for the client pieces inside the content column that need
 * to know where a path sits — today the error boundary, which offers the way back up when an
 * error replaced the page (and with it the page's back link).
 *
 * Plain data (nav-model.ts is serialisable by construction); `[]` outside the shell.
 */
const NavSectionsContext = createContext<NavSection[]>([]);

export const NavSectionsProvider = NavSectionsContext.Provider;

export function useNavSections(): NavSection[] {
  return useContext(NavSectionsContext);
}
