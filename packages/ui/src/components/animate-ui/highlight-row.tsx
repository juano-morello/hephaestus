/*
 * Follows the animate-ui row-highlight pattern (https://animate-ui.com, motion + Radix style).
 * Authored locally, not copied: the upstream registry item (primitives-effects-highlight) was
 * fetched on 2026-11-05 but is a sliding-highlight primitive built on a div container and
 * layoutId items, which does not fit a table row, and it ships under MIT + Commons Clause. So no
 * upstream source or license text is carried here.
 */
import { MotionConfig, motion } from "motion/react";
import { type ReactNode, useState } from "react";

/**
 * A table row whose background eases to the highlight color on hover and while focus is inside
 * it (a row is not focusable itself; focus events from its link bubble up to it).
 */
export function HighlightRow({ children }: { children: ReactNode }) {
  const [focused, setFocused] = useState(false);
  return (
    <MotionConfig reducedMotion="user">
      <motion.tr
        className="border-b border-line"
        data-highlighted={focused}
        initial={{ backgroundColor: "rgba(0,0,0,0)" }}
        animate={{ backgroundColor: focused ? "var(--surface-2)" : "rgba(0,0,0,0)" }}
        whileHover={{ backgroundColor: "var(--surface-2)" }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        transition={{ duration: 0.15 }}
      >
        {children}
      </motion.tr>
    </MotionConfig>
  );
}
