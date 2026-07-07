import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "warn" | "good";
type Size = "md" | "sm";

// Map onto main's single `.btn` system (globals.css): one button vocabulary.
const variantClass: Record<Variant, string> = {
  primary: "",
  secondary: "ghost",
  ghost: "ghost",
  danger: "danger",
  warn: "warn",
  good: "success",
};

function classes(variant: Variant, size: Size, block?: boolean, extra?: string) {
  return ["btn", variantClass[variant], size === "sm" ? "sm" : "", block ? "block" : "", extra ?? ""]
    .filter(Boolean)
    .join(" ");
}

type CommonProps = {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
};

/** Link-styled button (renders next/link). */
export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  block,
  icon,
  children,
  className,
  ...rest
}: CommonProps & { href: string } & Omit<ComponentProps<typeof Link>, "href" | "className">) {
  return (
    <Link href={href} className={classes(variant, size, block, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}

/** Action button (renders <button>). Safe in client components for onClick. */
export function Button({
  variant = "primary",
  size = "md",
  block,
  icon,
  loading,
  children,
  className,
  ...rest
}: CommonProps & { loading?: boolean } & Omit<ComponentProps<"button">, "className">) {
  return (
    <button className={classes(variant, size, block, className)} {...rest}>
      {icon}
      {children}
      {loading ? <span className="muted"> …</span> : null}
    </button>
  );
}
