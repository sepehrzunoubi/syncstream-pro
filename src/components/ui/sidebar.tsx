"use client";

import { cn } from "@/lib/utils";
import Link, { LinkProps } from "next/link";
import React, { useState, createContext, useContext, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";

interface Links {
  label: string;
  href: string;
  icon: React.JSX.Element | React.ReactNode;
}

interface SidebarContextProps {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggle: () => void;
  animate: boolean;
}

const SidebarContext = createContext<SidebarContextProps | undefined>(
  undefined
);

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
};

export const SidebarProvider = ({
  children,
  open: openProp,
  setOpen: setOpenProp,
  animate = true,
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
}) => {
  const [openState, setOpenState] = useState(false);

  const open = openProp !== undefined ? openProp : openState;
  const setOpen = setOpenProp !== undefined ? setOpenProp : setOpenState;
  const toggle = useCallback(() => setOpen((v) => !v), [setOpen]);

  return (
    <SidebarContext.Provider value={{ open, setOpen, toggle, animate }}>
      {children}
    </SidebarContext.Provider>
  );
};

export const Sidebar = ({
  children,
  open,
  setOpen,
  animate,
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
}) => {
  return (
    <SidebarProvider open={open} setOpen={setOpen} animate={animate}>
      {children}
    </SidebarProvider>
  );
};

export const SidebarBody = (props: React.ComponentProps<typeof motion.div>) => {
  return (
    <>
      <DesktopSidebar {...props} />
      <MobileSidebar {...(props as React.ComponentProps<"div">)} />
    </>
  );
};

/* ── Smooth spring config for width + opacity ─────────────────────────── */
const SIDEBAR_SPRING = { type: "spring", stiffness: 300, damping: 30, mass: 0.8 } as const;
const LABEL_VARIANTS = {
  hidden: { opacity: 0, x: -6, width: 0, marginLeft: 0 },
  visible: { opacity: 1, x: 0, width: "auto", marginLeft: 8 },
};
const LABEL_TRANSITION = { duration: 0.2, ease: "easeOut" as const };

export const DesktopSidebar = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof motion.div>) => {
  const { open, animate } = useSidebar();
  return (
    <motion.div
      className={cn(
        "h-full hidden md:flex md:flex-col flex-shrink-0 overflow-hidden relative",
        "bg-[#0c0c0e] border-r border-white/[0.04]",
        className
      )}
      animate={{
        width: animate ? (open ? 220 : 56) : 220,
      }}
      transition={SIDEBAR_SPRING}
      {...props}
    >
      {/* Sidebar inner content — padded */}
      <div
        className={cn(
          "flex flex-col h-full py-4 transition-[padding] duration-200 ease-out",
          open ? "px-3" : "px-1.5"
        )}
      >
        {children as React.ReactNode}
      </div>
    </motion.div>
  );
};

export const MobileSidebar = ({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) => {
  const { open, setOpen } = useSidebar();
  return (
    <>
      <div
        className={cn(
          "h-12 px-4 flex flex-row md:hidden items-center justify-between bg-[#0c0c0e] w-full border-b border-white/[0.04]"
        )}
        {...props}
      >
        <div className="flex justify-end z-20 w-full">
          <Menu
            className="text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
            onClick={() => setOpen(!open)}
          />
        </div>
        <AnimatePresence>
          {open && (
            <>
              {/* Backdrop */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[99]"
                onClick={() => setOpen(false)}
              />
              {/* Panel */}
              <motion.div
                initial={{ x: "-100%" }}
                animate={{ x: 0 }}
                exit={{ x: "-100%" }}
                transition={{ type: "spring", stiffness: 350, damping: 35 }}
                className={cn(
                  "fixed h-full w-[280px] inset-y-0 left-0 bg-[#0c0c0e] border-r border-white/[0.04] p-6 z-[100] flex flex-col justify-between",
                  className
                )}
              >
                <button
                  className="absolute right-4 top-4 text-zinc-500 hover:text-zinc-200 transition-colors"
                  onClick={() => setOpen(false)}
                >
                  <X className="h-5 w-5" />
                </button>
                {children}
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    </>
  );
};

export const SidebarLink = ({
  link,
  className,
  active,
  ...props
}: {
  link: Links;
  className?: string;
  active?: boolean;
  props?: LinkProps;
}) => {
  const { open } = useSidebar();
  return (
    <Link
      href={link.href}
      className={cn(
        "flex items-center py-2 px-2 rounded-lg whitespace-nowrap overflow-hidden",
        "transition-colors duration-150",
        active
          ? "bg-white/[0.06] text-zinc-100"
          : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04]",
        !open && "justify-center",
        className
      )}
      {...props}
    >
      <span className="flex-shrink-0 flex items-center justify-center w-5 h-5">
        {link.icon}
      </span>
      <AnimatePresence mode="wait">
        {open && (
          <motion.span
            key="label"
            variants={LABEL_VARIANTS}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={LABEL_TRANSITION}
            className="text-[13px] font-medium whitespace-nowrap overflow-hidden"
          >
            {link.label}
          </motion.span>
        )}
      </AnimatePresence>
    </Link>
  );
};
