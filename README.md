# Token Lists

CoW Swap default token lists and token image repository

## Managing the tokens

The process has been automated, and it's now much simpler.
The forms are self-explanatory and should contain all the info you need to proceed.

**Notes**:
- Images will be optimized in the background
- If you want to add a token/image to multiple networks, create one issue per network

Head to the [issues section](https://github.com/cowprotocol/token-lists/issues/new/choose) and pick your action:

### Add or update token

For adding tokens to CoW Swap's default token list, or to update an existing one, use the [`Add Token` form](https://github.com/cowprotocol/token-lists/issues/new?assignees=&labels=addToken&template=addTokenForm.yml&title=%5BAddToken%5D+%60SYMBOL%60+on+%60NETWORK%60).

### Remove token from the list

Use the [`Remove Token` form](https://github.com/cowprotocol/token-lists/issues/new?assignees=&labels=removeToken&template=removeTokenForm.yml&title=%5BRemoveToken%5D+%60SYMBOL%60+on+%60NETWORK%60).

Even though the token is removed from the default list, its image will be kept.

### Add or update image only

Not all tokens should be in the default token list, but the more token images we have the better UX.

For this, use the [`Add Image` form](https://github.com/cowprotocol/token-lists/issues/new?assignees=&labels=addImage&template=addImageForm.yml&title=%5BAddImage%5D+%60SYMBOL%60+on+%60NETWORK%60).


## Development

Instructions for setting up and running the various scripts locally

### Setup

```bash
# Install dependencies
yarn

# Generate Coingecko list
yarn coingecko
```

### Download images

There's a script that will fetch all images form the CowSwap list and store them in `src/public/images/<chainId>/<address>.png`

```
yarn downloadImages
```
