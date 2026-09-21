import mark from "../assets/paw-icon.png";

export function PawMark({
  size = 32,
  className,
}: { size?: number; className?: string }) {
  return (
    <img
      src={mark}
      width={size}
      height={size}
      className={className}
      alt="Paw"
      draggable={false}
      style={{ objectFit: "contain", flexShrink: 0 }}
    />
  );
}
