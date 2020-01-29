# NB: This version supports only Metamask and web3 providers implementing [EIP 712](https://github.com/ethereum/EIPs/blob/master/EIPS/eip-712.md)


# Enigma CoinJoin - Client Package

This is a simply client library that wraps the business logic to be included in a frontend.
It interfaces with the operator (through a WS client) and Ethereum (through Web3). 

It uses common-js modules for convenience when unit testing with node.


## Port to the browser

I recommend using browserify (or WebPack) to port this library to the browser. 
Use hot module replacement to switch to the browser version of `enigma-js` when bundling.
Other alternatives are acceptable as well, but in my opinion, this is the simplest.
 

