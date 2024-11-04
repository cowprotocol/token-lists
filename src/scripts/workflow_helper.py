import json
import os
import sys

LIST_PATH = os.environ["LIST_PATH"]


def handle_add_update_token(data):
    with open(LIST_PATH, "r+") as f:
        token_list = json.load(f)

        for token in token_list["tokens"]:
            # update
            if token["address"].lower() == data["address"].lower() and token["chainId"] == int(data["chainId"]):
                token["address"] = data["address"].lower()
                token["symbol"] = data["symbol"]
                token["name"] = data["name"]
                token["logoURI"] = data["logoURI"]
                token["decimals"] = int(data["decimals"])
                token["chainId"] = int(data["chainId"])
                break
        else:
            # add
            token_list["tokens"].append(
                {
                    "address": data["address"].lower(),
                    "symbol": data["symbol"],
                    "name": data["name"],
                    "decimals": int(data["decimals"]),
                    "chainId": int(data["chainId"]),
                    "logoURI": data["logoURI"],
                }
            )
        token_list["tokens"] = sort_token_list(token_list["tokens"])
        f.seek(0)
        f.truncate()
        json.dump(token_list, f, indent=2)

    handle_info_json(data)


def sort_token_list(tokens):
    """
    Sort token list by chainId, then address
    """
    tokens.sort(key=lambda x: (x["chainId"], x["address"].lower()))
    return tokens


def handle_remove_token(data):
    with open(LIST_PATH, "r+") as f:
        token_list = json.load(f)

        token_list["tokens"] = [
            token
            for token in token_list["tokens"]
            if token["address"].lower() != data["address"].lower()
        ]

        f.seek(0)
        f.truncate()
        json.dump(token_list, f, indent=2)

    handle_info_json(data, removed=True)


def handle_info_json(data, removed=False):
    file_path = f'src/public/images/{data["chainId"]}/{data["address"].lower()}/info.json'

    with open(file_path, "r+") as f:
        try:
            info = json.load(f)
        except json.decoder.JSONDecodeError:
            # File is empty
            info = {}

        info["removed"] = removed
        info["address"] = data["address"].lower()
        if data.get("symbol"): info["symbol"] = data["symbol"]
        if data.get("name"): info["name"] = data["name"]
        if data.get("logoURI"): info["logoURI"] = data["logoURI"]
        if data.get("reason"): info["reason"] = data["reason"]
        if data.get("decimals"): info["decimals"] = int(data["decimals"])
        if data.get("chainId"): info["chainId"] = int(data["chainId"])

        f.seek(0)
        f.truncate()
        json.dump(info, f, indent=2)


def handle_sort_list():
    with open(LIST_PATH, "r+") as f:
        token_list = json.load(f)
        token_list["tokens"] = sort_token_list(token_list["tokens"])
        f.seek(0)
        f.truncate()
        json.dump(token_list, f, indent=2)


def main():
    option = sys.argv[1]

    if option == "sortList":
        handle_sort_list()
        return

    data_file = sys.argv[2]

    with open(data_file) as f:
        loaded_data = json.load(f)
        print(loaded_data)

    if option == "addToken":
        handle_add_update_token(loaded_data)
    elif option == "removeToken":
        handle_remove_token(loaded_data)
    elif option == "addImage":
        handle_info_json(loaded_data)
    else:
        print("Wrong option")
        exit


if __name__ == "__main__":
    main()
