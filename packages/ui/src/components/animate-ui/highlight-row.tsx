/*
 * Follows the animate-ui row-highlight pattern (https://animate-ui.com, motion + Radix style).
 * Authored locally: the upstream source could not be fetched when this was written, so this is
 * not a copy of upstream code and carries no upstream license text.
 */
import { motion } from "motion/react";
import type { ReactNode } from "react";

/** A table row whose background eases to the highlight color on hover and keyboard focus. */
export function HighlightRow({ children }: { children: ReactNode }) {
  return (
    <motion.tr
      className="border-b border-line"
      initial={{ backgroundColor: "rgba(0,0,0,0)" }}
      whileHover={{ backgroundColor: "var(--surface-2)" }}
      whileFocus={{ backgroundColor: "var(--surface-2)" }}
      transition={{ duration: 0.15 }}
    >
      {children}
    </motion.tr>
  );
}
