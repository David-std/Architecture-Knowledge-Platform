import React from "react";

export interface InfoTooltipProps {
  text: string;
  label?: string;
}

export function InfoTooltip({ text, label }: InfoTooltipProps) {
  return (
    <span
      className="info-tooltip-wrap"
      tabIndex={0}
      role="tooltip"
      aria-label={label || text}
    >
      <span className="info-tooltip-icon" aria-hidden="true">
        ?
      </span>
      <span className="info-tooltip-bubble">{text}</span>
    </span>
  );
}
