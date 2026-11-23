/** Display only, putting the median ranked roster near 1500. Never feed a published rating back into the model. */
export const PUBLISHED_RATING_OFFSET = 2000;

export const publishRating = (ratingWithPrior: number): number =>
    Math.round((ratingWithPrior + PUBLISHED_RATING_OFFSET) * 10) / 10;
