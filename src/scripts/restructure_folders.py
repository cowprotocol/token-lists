#! /usr/bin/python3

'''
One off script for restructuring image folders

To be run on src/public/images folder

Old structure:
<chainId>/<address>.png

New structure:
<chainId>/<address>/logo.png
<chainId>/<address>/info.json

info.json is created with an empty object inside
'''

import os

def createDir(name):
    print(f"Moving {name}")
    os.makedirs(name, exist_ok=True)
    os.rename(f"./{name}.png", f"./{name}/logo.png")
    with open(f"./{name}/info.json", 'w') as f:
        f.write('{}')

def main():
    for chain in [100, 1]:
        for address in os.listdir(f"./{chain}"):
            print(address, os.path.isfile(os.path.join(f"{chain}", address)))
            if address.endswith('.png') and os.path.isfile(os.path.join(f"{chain}", address)):
                print(chain, address)
                createDir(os.path.join(f"{chain}", address.split('.')[0]))

if __name__ == '__main__':
    main()