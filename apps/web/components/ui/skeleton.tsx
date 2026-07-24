import type { CSSProperties, ReactElement } from "react";

export function Skeleton({
  width = "100%",
  height = 14,
  className,
}: {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  className?: string;
}): ReactElement {
  return (
    <span
      className={className ? `ff-skeleton ${className}` : "ff-skeleton"}
      style={{ display: "block", width, height }}
      aria-hidden="true"
    />
  );
}
