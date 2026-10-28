import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "../lib/utils"

// Design: Foundations › Buttons. One primary button per view; 30px on desktop, 48px in the staff app.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90",
        secondary: "border border-border bg-surface text-foreground hover:bg-hover",
        outline: "border border-border bg-surface text-foreground hover:bg-hover",
        ghost: "text-foreground hover:bg-hover",
        destructive: "bg-st-red text-white hover:opacity-90",
        link: "text-link underline-offset-4 hover:underline px-0",
      },
      size: {
        default: "h-[30px] px-3",
        sm: "h-7 px-2.5 text-[12.5px]",
        lg: "h-[38px] px-4 text-sm",
        field: "h-12 px-5 text-base rounded-lg w-full",
        icon: "size-[30px]",
        "icon-sm": "size-7",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
