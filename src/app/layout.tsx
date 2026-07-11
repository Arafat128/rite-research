import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

const inter = Inter({ subsets: ["latin"], variable: "--font-geist-sans" });
const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Rite — Ritual Research Desk",
  description:
    "Pay-per-prompt crypto research and data agents on Ritual Chain. Powered by Surf AI.",
  applicationName: "Rite",
  keywords: [
    "Ritual",
    "Rite",
    "crypto research",
    "on-chain agents",
    "Surf AI",
  ],
  robots: { index: true, follow: true },
  openGraph: {
    title: "Rite — Ritual Research Desk",
    description:
      "Pay-per-prompt crypto research and data agents on Ritual Chain.",
    type: "website",
    siteName: "Rite",
  },
  twitter: {
    card: "summary",
    title: "Rite — Ritual Research Desk",
    description:
      "Pay-per-prompt crypto research and data agents on Ritual Chain.",
  },
  other: {
    "theme-color": "#04140c",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${display.variable} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
