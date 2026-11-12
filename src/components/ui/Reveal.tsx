import React from 'react';

interface Props {
  show: boolean;
  children: React.ReactNode;
}

/**
 * Smoothly expands and collapses a block without changing the height in one
 * jump. The content stays mounted (state is kept) but is hidden and inert
 * while collapsed.
 */
export const Reveal: React.FC<Props> = ({ show, children }) => (
  <div className={`reveal ${show ? 'open' : ''}`} aria-hidden={!show} inert={!show || undefined}>
    <div className="reveal-inner">{children}</div>
  </div>
);
