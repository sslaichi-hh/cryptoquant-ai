import React from "react";

type ChartSurfaceProps = {
  className?: string;
  minHeight?: number;
  children: (size: { width: number; height: number }) => React.ReactNode;
};

export function ChartSurface({
  className,
  minHeight = 280,
  children,
}: ChartSurfaceProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      setSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height }
      );
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{ minHeight }}
    >
      {size.width > 0 && size.height > 0 ? children(size) : null}
    </div>
  );
}
