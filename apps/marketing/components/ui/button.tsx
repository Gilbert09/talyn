import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-clay text-white shadow-glow-clay hover:bg-clay-600 hover:-translate-y-0.5 active:translate-y-0",
        secondary:
          "border border-line-strong bg-white text-ink shadow-soft hover:bg-paper-100 hover:border-ink-400/40",
        ghost: "text-ink-600 hover:bg-ink/[0.04] hover:text-ink",
        outline:
          "border border-line-strong text-ink hover:border-clay/50 hover:text-clay-600",
      },
      size: {
        sm: "h-9 px-4",
        md: "h-11 px-5",
        lg: "h-[52px] px-7 text-base",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
);
Button.displayName = "Button";

export { Button, buttonVariants };
