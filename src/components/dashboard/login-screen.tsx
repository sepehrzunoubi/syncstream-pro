"use client";

import React, { useEffect, useMemo, useState } from "react";
import { motion, useInView } from "framer-motion";
import {
  MoveRight,
  FileText,
  Zap,
  Shield,
  Clock,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const quotes = [
  "\u201CI can doomscroll and \u2018write\u2019 at the same time. Productivity unlocked.\u201D",
  "\u201CVersion history looks like a real person typed it. Chef\u2019s kiss.\u201D",
  "\u201CFinally can go make coffee while my essay writes itself.\u201D",
  "\u201Cgot distracted.\u201D",
  "\u201CMy professor has no idea. 10/10.\u201D",
  "\u201CThe typos make it look so real, I almost believed it myself.\u201D",
];

const features = [
  {
    icon: FileText,
    title: "Google Docs Integration",
    desc: "Connect your Google account and pick any doc. Sync handles the rest.",
  },
  {
    icon: Zap,
    title: "Human-Like Typing",
    desc: "Natural pacing, random pauses, and micro-corrections that fool version history.",
  },
  {
    icon: Clock,
    title: "Set It and Forget It",
    desc: "Paste your text, hit start, and walk away. Sync types while you do literally anything else.",
  },
  {
    icon: Shield,
    title: "Secure OAuth",
    desc: "We never store your password. Google OAuth 2.0 keeps your account safe.",
  },
];

const faqs = [
  {
    q: "How does Sync actually work?",
    a: "You paste your text, choose a Google Doc, and Sync types it character by character with realistic human timing. It even adds occasional typos and corrections.",
  },
  {
    q: "Will my professor/boss know?",
    a: "Version history will show the text being typed out gradually over time, just like a real person would. No copy-paste timestamps.",
  },
  {
    q: "Is my Google account safe?",
    a: "We use Google OAuth 2.0 and never see your password. You can revoke access anytime from your Google account settings.",
  },
  {
    q: "How fast does it type?",
    a: "You control the speed. Default is around 40-80 WPM with natural variation, but you can adjust it to match your usual typing speed.",
  },
];

function AnimatedSection({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = React.useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen(!open)}
      className="w-full text-left border border-white/[0.06] rounded-xl bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
    >
      <div className="flex items-center justify-between px-6 py-5">
        <span className="text-[15px] font-medium text-zinc-200">{q}</span>
        <ChevronDown
          className={`w-4 h-4 text-zinc-500 transition-transform duration-200 flex-shrink-0 ml-4 ${
            open ? "rotate-180" : ""
          }`}
        />
      </div>
      <motion.div
        initial={false}
        animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
        transition={{ duration: 0.25, ease: "easeInOut" }}
        className="overflow-hidden"
      >
        <div className="px-6 pb-5 text-sm text-zinc-500 leading-relaxed">
          {a}
        </div>
      </motion.div>
    </button>
  );
}

export function LoginScreen() {
  const [titleNumber, setTitleNumber] = useState(0);
  const titles = useMemo(
    () => ["seamless", "human", "natural", "effortless", "intelligent"],
    []
  );

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (titleNumber === titles.length - 1) {
        setTitleNumber(0);
      } else {
        setTitleNumber(titleNumber + 1);
      }
    }, 2000);
    return () => clearTimeout(timeoutId);
  }, [titleNumber, titles]);

  return (
    <div className="w-full relative scroll-smooth">
      {/* Top Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/[0.04] bg-[#09090b]/80 backdrop-blur-md">
        <div className="container mx-auto flex items-center justify-between px-6 py-4">
          <a
            href="/"
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <img
              src="/sync-icon.png"
              alt="Sync"
              className="h-7 w-7 object-contain"
            />
            <span className="text-sm font-semibold text-white tracking-tight">
              SyncStream
            </span>
          </a>
          <div className="flex items-center gap-8">
            <a
              href="#features"
              className="text-sm text-zinc-400 hover:text-white transition-colors"
            >
              Features
            </a>
            <a
              href="#faq"
              className="text-sm text-zinc-400 hover:text-white transition-colors"
            >
              FAQ
            </a>
            <a href="/api/auth/login">
              <Button size="sm" className="gap-2">
                Get Started <MoveRight className="w-3 h-3" />
              </Button>
            </a>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden">
        <div className="container mx-auto relative z-10">
          <div className="flex gap-12 pt-16 pb-16 lg:pt-20 lg:pb-20 items-center justify-center flex-col">
            <div>
              <Button variant="secondary" size="sm" className="gap-4">
                Human-cadence document sync{" "}
                <MoveRight className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex gap-6 flex-col">
              <h1 className="text-5xl md:text-7xl lg:text-8xl max-w-3xl tracking-tighter text-center font-regular">
                <span className="text-white">Sync makes text</span>
                <span className="relative flex w-full justify-center overflow-hidden text-center md:pb-6 md:pt-6">
                  &nbsp;
                  {titles.map((title, index) => (
                    <motion.span
                      key={index}
                      className="absolute font-semibold text-blue-400"
                      initial={{ opacity: 0, y: "-100" }}
                      transition={{ duration: 0.35, ease: "easeInOut" }}
                      animate={
                        titleNumber === index
                          ? { y: 0, opacity: 1 }
                          : {
                              y: titleNumber > index ? -80 : 80,
                              opacity: 0,
                            }
                      }
                    >
                      {title}
                    </motion.span>
                  ))}
                </span>
              </h1>

              <p className="text-lg md:text-xl leading-relaxed tracking-tight text-muted-foreground max-w-2xl text-center">
                Paste your text, pick a Google Doc, and let Sync type it out for
                you with natural pacing, realistic pauses, and the occasional
                correction. It looks and feels like a real person writing.
              </p>
            </div>
            <div className="flex flex-row gap-3">
              <a href="/api/auth/login">
                <Button
                  size="lg"
                  className="gap-4 hover:scale-[1.01] hover:brightness-90 active:brightness-85 active:scale-100 transition-all duration-200"
                >
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                  </svg>
                  Connect Google Account <MoveRight className="w-4 h-4" />
                </Button>
              </a>
            </div>
          </div>
        </div>

        {/* Scrolling testimonials - seamless infinite loop */}
        <div className="w-full overflow-hidden pointer-events-none pb-12">
          <div className="max-w-5xl mx-auto overflow-hidden mask-fade">
            <div className="flex gap-6 animate-scroll-faster whitespace-nowrap">
              {[...quotes, ...quotes].map((quote, i) => (
                <div
                  key={i}
                  className="inline-flex items-center px-5 py-3 rounded-full bg-white/[0.03] border border-white/[0.06] text-sm text-zinc-500 flex-shrink-0"
                >
                  {quote}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="pt-24 pb-16 relative z-10">
        <div className="container mx-auto px-6">
          <AnimatedSection className="text-center mb-16">
            <p className="text-sm font-medium text-blue-400 mb-3 tracking-wide uppercase">
              Features
            </p>
            <h2 className="text-3xl md:text-5xl tracking-tighter font-regular text-white">
              Everything you need to look productive
            </h2>
          </AnimatedSection>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
            {features.map((feature, i) => (
              <AnimatedSection key={i} delay={i * 0.1}>
                <div className="group p-6 rounded-2xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/[0.1] transition-all duration-300">
                  <div className="flex items-start gap-4">
                    <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20 group-hover:bg-blue-500/15 transition-colors">
                      <feature.icon className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <h3 className="text-[15px] font-semibold text-zinc-200 mb-1.5">
                        {feature.title}
                      </h3>
                      <p className="text-sm text-zinc-500 leading-relaxed">
                        {feature.desc}
                      </p>
                    </div>
                  </div>
                </div>
              </AnimatedSection>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="pt-0 pb-12 relative z-10">
        <div className="container mx-auto px-6">
          <AnimatedSection className="text-center mb-6">
            <p className="text-sm font-medium text-blue-400 mb-3 tracking-wide uppercase">
              How it works
            </p>
            <h2 className="text-3xl md:text-5xl tracking-tighter font-regular text-white">
              Three steps. That&apos;s it.
            </h2>
          </AnimatedSection>

          <div className="flex flex-col md:flex-row gap-8 max-w-4xl mx-auto">
            {[
              {
                step: "01",
                title: "Connect Google",
                desc: "Sign in with your Google account. Takes about 3 seconds.",
              },
              {
                step: "02",
                title: "Paste your text",
                desc: "Drop in whatever you need typed. An essay, notes, anything.",
              },
              {
                step: "03",
                title: "Hit start",
                desc: "Sync types it into your Google Doc like a real person. Go do something fun.",
              },
            ].map((item, i) => (
              <AnimatedSection
                key={i}
                delay={i * 0.15}
                className="flex-1"
              >
                <div className="p-6 rounded-2xl border border-white/[0.06] bg-white/[0.02] text-center">
                  <div className="text-3xl font-bold text-blue-400/30 mb-3">
                    {item.step}
                  </div>
                  <h3 className="text-[15px] font-semibold text-zinc-200 mb-2">
                    {item.title}
                  </h3>
                  <p className="text-sm text-zinc-500 leading-relaxed">
                    {item.desc}
                  </p>
                </div>
              </AnimatedSection>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section id="faq" className="py-24 relative z-10">
        <div className="container mx-auto px-6">
          <AnimatedSection className="text-center mb-16">
            <p className="text-sm font-medium text-blue-400 mb-3 tracking-wide uppercase">
              FAQ
            </p>
            <h2 className="text-3xl md:text-5xl tracking-tighter font-regular text-white">
              Questions? Answers.
            </h2>
          </AnimatedSection>

          <AnimatedSection delay={0.1}>
            <div className="flex flex-col gap-3 max-w-2xl mx-auto">
              {faqs.map((faq, i) => (
                <FAQItem key={i} q={faq.q} a={faq.a} />
              ))}
            </div>
          </AnimatedSection>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="py-24 relative z-10">
        <AnimatedSection className="text-center">
          <div className="container mx-auto px-6">
            <h2 className="text-3xl md:text-5xl tracking-tighter font-regular text-white mb-4">
              Ready to stop typing?
            </h2>
            <p className="text-zinc-500 text-lg mb-8 max-w-lg mx-auto">
              Connect your Google account and let Sync do the boring part.
            </p>
            <a href="/api/auth/login">
              <Button
                size="lg"
                className="gap-4 hover:scale-[1.01] hover:brightness-90 active:brightness-85 active:scale-100 transition-all duration-200"
              >
                Get Started Free <MoveRight className="w-4 h-4" />
              </Button>
            </a>
          </div>
        </AnimatedSection>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/[0.04] py-8 relative z-10">
        <div className="container mx-auto px-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img
              src="/sync-icon.png"
              alt="Sync"
              className="h-5 w-5 object-contain"
            />
            <span className="text-xs text-zinc-600">SyncStream</span>
          </div>
          <span className="text-xs text-zinc-600">
            &copy; {new Date().getFullYear()} SyncStream
          </span>
        </div>
      </footer>
    </div>
  );
}
