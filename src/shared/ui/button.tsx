import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { Slot } from "radix-ui";

import { cn } from "@/utils/cn";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  loadingLabel,
  children,
  disabled,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /**
     * The action this button started has not finished.
     *
     * Renders a spinner, disables the button and marks it `aria-busy`, so a
     * click always produces visible feedback and cannot be repeated. Seventeen
     * components used to spell this out by hand and disagreed about the details
     * — some swapped the label and jumped in width, some did not disable at all.
     *
     * Being disabled is what prevents the double submit. It is not a delay and
     * it is not decoration: `loading` should be driven by the real pending state
     * of the request, never by a timer.
     */
    loading?: boolean;
    /**
     * Replaces the label while loading — "Signing in" for "Sign in".
     *
     * Optional, because swapping the text is sometimes worse than keeping it:
     * an icon-only button has nothing to say, and a short label that grows makes
     * the row reflow. When omitted the original label stays and only the spinner
     * appears.
     */
    loadingLabel?: React.ReactNode;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  /*
   * `asChild` renders someone else's element — usually a link — and Slot demands
   * exactly one child. Injecting a spinner would break that, and a link has no
   * pending state to show anyway, so the loading affordance is skipped there.
   */
  if (asChild) {
    return (
      <Comp
        data-slot="button"
        data-variant={variant}
        data-size={size}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      >
        {children}
      </Comp>
    );
  }

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "true" : undefined}
      aria-busy={loading || undefined}
      disabled={disabled ?? loading}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {loadingLabel !== undefined ? (
        /*
         * Both labels are ALWAYS in the layout, stacked in one grid cell, and
         * only their visibility changes. The cell is as wide as the wider of the
         * two in both states, so the button never resizes when the request
         * starts or finishes.
         *
         * Rendering only the active label — which is what these buttons used to
         * do, and what an earlier version of this fix still did — moves the
         * layout at the exact moment the operator is watching it. It moves in
         * both directions, too: "Change password" → "Changing" shrinks, while
         * "Save" → "Saving" grows once the spinner is added. Keeping both
         * present is the only version that holds for either.
         *
         * The inactive copy is `aria-hidden` and `invisible` rather than
         * `hidden`, because it still has to occupy space. `aria-busy` on the
         * button is what announces the state.
         */
        <span className="grid items-center justify-items-center">
          <span
            className={cn(
              "col-start-1 row-start-1 inline-flex items-center gap-2",
              loading && "invisible",
            )}
            aria-hidden={loading || undefined}
          >
            {children}
          </span>
          <span
            className={cn(
              "col-start-1 row-start-1 inline-flex items-center gap-2",
              !loading && "invisible",
            )}
            aria-hidden={!loading || undefined}
          >
            <LoaderCircle className="animate-spin" aria-hidden="true" />
            {loadingLabel}
          </span>
        </span>
      ) : loading ? (
        /* No replacement label: the spinner joins the existing content. */
        <>
          <LoaderCircle className="animate-spin" aria-hidden="true" />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

export { Button, buttonVariants };
