# Use Vercel and Vercel Blob for v1

Artifacts v1 will deploy on Vercel and store Artifact contents in Vercel Blob because TheFocus.AI already operates several services on Vercel and the product needs a low-friction CLI-first publishing path more than a maximally optimized static-serving stack. Cloudflare Workers and R2 remain a plausible future alternative, but introducing that platform now would add operational surface before the traffic and cost profile justify it.
