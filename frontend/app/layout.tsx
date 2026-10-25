import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OxRide",
  description: "Time-aware cycle navigation for Oxford",
};

// - viewportFit "cover": use the whole iPhone screen, under the notch and home bar
//   (the app adds padding there itself with safe-area-inset, see Map.tsx)
// - themeColor: the colour phones give the browser bars, the card colour of the
//   light or dark palette (hooks/useTheme.ts updates it when the toggle is used)
export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f0d9" },
    { media: "(prefers-color-scheme: dark)", color: "#343f44" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={cn(
        "h-full",
        "antialiased",
        geistSans.variable,
        geistMono.variable,
        "font-sans",
        inter.variable,
      )}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
