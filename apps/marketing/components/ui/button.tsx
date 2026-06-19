import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-talon/60 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-talon text-ink shadow-glow-talon hover:bg-talon-300 hover:-translate-y-0.5 active:translate-y-0",
        secondary:
          "bg-white/[0.06] text-white ring-hairline backdrop-blur hover:bg-white/[0.10]",
        ghost: "text-owl-50/80 hover:text-white hover:bg-white/[0.06]",
        outline:
          "border border-white/15 text-white hover:border-talon/50 hover:text-talon-300",
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
