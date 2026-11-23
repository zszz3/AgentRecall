import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names and lets a later Tailwind utility replace an earlier one of the same kind. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
