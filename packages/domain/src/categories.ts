import { z } from "zod";

/**
 * Macro category and nested subcategory. The domain only models the identity
 * and shape; category memory and AI suggestions live in the categorization
 * package, not here.
 */

export type Category = {
  id: string;
  householdId: string;
  name: string;
};

export type Subcategory = {
  id: string;
  householdId: string;
  categoryId: string;
  name: string;
};

export const categorySchema = z.object({
  id: z.string().min(1),
  householdId: z.string().min(1),
  name: z.string().min(1),
});

export const subcategorySchema = z.object({
  id: z.string().min(1),
  householdId: z.string().min(1),
  categoryId: z.string().min(1),
  name: z.string().min(1),
});

/**
 * A category assignment on a transaction. Both levels are optional so a
 * transaction can be saved uncategorized and reviewed later.
 */
export type CategoryRef = {
  categoryId?: string;
  subcategoryId?: string;
};

export const categoryRefSchema = z.object({
  categoryId: z.string().min(1).optional(),
  subcategoryId: z.string().min(1).optional(),
});
