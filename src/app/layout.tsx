import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Providers } from "@/components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Foundry Lab — Agentic Research Workflow Studio",
  description:
    "Design agentic research workflows on a visual canvas. Merge foundry-ui + Vitrual-lab with an enhanced agent layer.",
  keywords: [
    "Foundry Lab",
    "agentic research",
    "workflow canvas",
    "Next.js",
    "TypeScript",
    "LLM agents",
    "protein design",
  ],
  authors: [{ name: "Foundry Lab" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "Foundry Lab — Agentic Research Workflow Studio",
    description:
      "Design agentic research workflows on a visual canvas. Merge foundry-ui + Vitrual-lab with an enhanced agent layer.",
    siteName: "Foundry Lab",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Foundry Lab",
    description:
      "Design agentic research workflows on a visual canvas.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
