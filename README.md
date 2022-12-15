# Token Lists

Automatically generate Token Lists

## How to add an image to the CoW Swap default token list

In order to add a new token to the CoW Swap default token list follow these steps

- Find an icon with reasonable quality/size (~256px, <100kB).
- Add the icon to `src/public/images/<chainId>/<address>.png` [^1]
- Upload the image to Pinata (login in 1Password)
- Create a new entry in `src/public/CowSwap.json` containing token address, symbol, etc. (**use IPFS link for icon!**)
- Make sure you bump the version using SemVersions
- Create a PR with these changes

[^1]: To resize/convert your image [ImageMagick](https://formulae.brew.sh/formula/imagemagick) installed you can simply run `convert ~/Downloads/img.png -resize 256 src/public/images/<chainId>/<address>.png`

## Setup

```bash
# Install dependencies
yarn

# Generate Coingecko list
yarn coingecko
```

## Download images

There's a script that will fetch all images form the CowSwap list and store them in `src/public/images/<chainId>/<address>.png`

```
yarn downloadImages
```
