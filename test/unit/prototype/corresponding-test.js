
let verbose = false

//get the target nodes for a given corresponding sender
//this only has to be computed once time no matter how many facts are being shared
function getCorrespondingNodes(ourIndex, startTargetIndex, endTargetIndex, globalOffset, receiverGroupSize, sendGroupSize, transactionGroupSize){
    let wrappedIndex
    let targetNumber 
    let found = false

    let unWrappedEndIndex = -1
    // handle case where receiver group is split (wraps around)
    if(startTargetIndex > endTargetIndex){
        unWrappedEndIndex = endTargetIndex
        endTargetIndex = endTargetIndex + transactionGroupSize
    }

    //wrap our index to the send group size
    ourIndex = ourIndex % sendGroupSize
    
    //In theory this loop could be but it is very fast loop,
    //  should make sure unit tests pass if we do optimize it.
    //find our initial staring index into the receiver group (wrappedIndex)
    for(let i = startTargetIndex; i < endTargetIndex; i++){
        wrappedIndex = i        
        if(i >= transactionGroupSize){
            wrappedIndex =  i - transactionGroupSize
        }
        targetNumber = (i + globalOffset) % receiverGroupSize  
        if (targetNumber === ourIndex) {
            found = true
            break
        }
    }
    if(!found){
        //return empty array
        return []
    }

    let destinationNodes = []
    //this loop is at most O(k) where k is  receiverGroupSize / sendGroupSize
    //effectively it is constant time it is required so that a smaller 
    //group can send to a larger group
    while(targetNumber < receiverGroupSize){
        //send all payload to this node  
        let destinationNode = wrappedIndex
        
        destinationNodes.push(destinationNode)
        //console.log(`sender ${ourIndex} send all payload to node ${destinationNode} targetNumber ${targetNumber} `)

        // //in-place verification check
        // let sendingNodeIndex  = ourIndex
        // let receivingNodeIndex = destinationNode
        // //extra step here, remove in production
        // verifySender(receivingNodeIndex, sendingNodeIndex)

        //this part is a bit tricky.  
        //we are incrementing two indexes that control our loop
        //wrapped index will have various corrections so that it can 
        //wrap past the end of a split span, or wrap within the range
        //of the receiver group
        targetNumber += sendGroupSize
        wrappedIndex += sendGroupSize

        //wrap to front of transaction group
        if(wrappedIndex >= transactionGroupSize){
            wrappedIndex = wrappedIndex - transactionGroupSize
        }
        //wrap to front of receiver group
        if(wrappedIndex >= endTargetIndex){
            wrappedIndex = wrappedIndex - receiverGroupSize
        }
        //special case to stay in bounds when we have a split index and
        //the unWrappedEndIndex is smaller than the start index.
        //i.e.  startTargetIndex = 45, endTargetIndex = 5  for a 50 node group 
        if(unWrappedEndIndex != -1 && wrappedIndex >= unWrappedEndIndex){
            let howFarPastUnWrapped = wrappedIndex - unWrappedEndIndex
            wrappedIndex = startTargetIndex + howFarPastUnWrapped
        }
    }
    return destinationNodes
}

function verifyCorrespondingSender(receivingNodeIndex, sendingNodeIndex, globalOffset, receiverGroupSize, sendGroupSize) {
    //note, in the gather case, we need to check the address range of the sender node also, to prove
    //that it does cover the given account range
    
    let targetIndex = (((receivingNodeIndex + globalOffset) % receiverGroupSize) % sendGroupSize)
    let targetIndex2 = sendingNodeIndex % sendGroupSize
    if (targetIndex === targetIndex2) {
        if(verbose) console.log(`verification passed ${targetIndex} === ${targetIndex2}  ${sendingNodeIndex}->${receivingNodeIndex}`)
        return true
    } else{
        console.log(`X verification failed ${targetIndex} !== ${targetIndex2} `)
        return false
    }
}


//////////JUST TEST CASES BELOW HERE////////////////////

//But also an example of how to use the above functions


//push several test cases into an array
let receiverTestCases = []

// trivial case
receiverTestCases.push({startTargetIndex: 13, endTargetIndex: 23, transactionGroupSize: 50, senderStartRange:33, senderEndRange:43,  sendGroupSize: 10})

// trivial case, half the sender size
receiverTestCases.push({startTargetIndex: 13, endTargetIndex: 23, transactionGroupSize: 50, senderStartRange:35, senderEndRange:40,  sendGroupSize: 5})

// wrap around case
receiverTestCases.push({startTargetIndex: 45, endTargetIndex: 5, transactionGroupSize: 50, senderStartRange:0, senderEndRange:10,  sendGroupSize: 10})

// smaller receiver group
receiverTestCases.push({startTargetIndex: 13, endTargetIndex: 18, transactionGroupSize: 50, senderStartRange:0, senderEndRange:10,  sendGroupSize: 10})

// send to whole transaction group (disperse case)  
receiverTestCases.push({startTargetIndex: 0, endTargetIndex: 50, transactionGroupSize: 50, senderStartRange:0, senderEndRange:10,  sendGroupSize: 10})

// larger case
receiverTestCases.push({startTargetIndex: 3000, endTargetIndex: 3128, transactionGroupSize: 5000, senderStartRange:100, senderEndRange:228,  sendGroupSize: 128})

// overlap case
receiverTestCases.push({startTargetIndex: 15, endTargetIndex: 25, transactionGroupSize: 50, senderStartRange:10, senderEndRange:20,  sendGroupSize: 10})


let testNumber = 0
for(let test of receiverTestCases){
    testNumber++
    let {startTargetIndex, endTargetIndex, transactionGroupSize, senderStartRange, senderEndRange, sendGroupSize} = test 
    let receiverGroupSize = endTargetIndex - startTargetIndex
    let globalOffset = Math.round(Math.random() * 1000) 

    console.log(`test case ${testNumber} startTargetIndex:${startTargetIndex} endTargetIndex:${endTargetIndex} transactionGroupSize:${transactionGroupSize} sendGroupSize:${sendGroupSize} globalOffset:${globalOffset}`)

    let coverage = new Array(transactionGroupSize).fill(0)
    for(let sendTest=senderStartRange; sendTest < senderEndRange; sendTest++){
        //console.log(`sendTest ${sendTest}`)
        let ourIndex = sendTest 
        
        //get a list of destination nodes for this sender
        let destinationNodes = getCorrespondingNodes(ourIndex, startTargetIndex, endTargetIndex, globalOffset, receiverGroupSize, sendGroupSize, transactionGroupSize)
        
        //cheap hack to test that verification can refute things
        //globalOffset++

        //this is the list of nodes that we should send to,
        //in this test we will increment a coverage array 
        for(let i of destinationNodes){
            coverage[i]++

            //NOTE, This is where we would send the payload 
            //for tellCorrespondingNodes we would send all accounts we cover
            //for tellCorrespondingNodesFinalData we would look at the receiver storage range and send only the accounts are covered
            
            //verification check
            let sendingNodeIndex  = ourIndex
            let receivingNodeIndex = i
            //extra step here, remove in production
            verifyCorrespondingSender(receivingNodeIndex, sendingNodeIndex, globalOffset, receiverGroupSize, sendGroupSize)      
        }
    }

    //each sender evaluates on its own, so wrapping math not a concern, but we could still test for it
    //this was tested before but would need a little more work to use make it dynamically
    //turned on/off based on the sender group wrapping or not
    // for(let sendTest=0; sendTest < 5; sendTest++){
    //     //console.log(`sendTest ${sendTest}`)
    //     ourIndex = sendTest 
    //     ourIndex = ourIndex % sendGroupSize

    //     //get a list of destination nodes for this sender
    //     let destinationNodes = getDestinationNodes(ourIndex, startTargetIndex, endTargetIndex, globalOffset, receiverGroupSize, sendGroupSize)
        
    //     for(let i of destinationNodes){
    //         coverage[i]++
    //     }
    // }

    //verify coverage
    for(i = startTargetIndex; i < endTargetIndex; i++){
        let wrappedIndex = i        
        if(i >= transactionGroupSize){
            wrappedIndex =  i % transactionGroupSize
        }
        if(verbose) console.log(`coverage ${i} ${wrappedIndex}   ${coverage[wrappedIndex]}`)
    }
    
    //check to make sure we did not cover anything outside of the target range
    for(let i = 0; i < transactionGroupSize; i++){
        if( i < startTargetIndex || i >= endTargetIndex){
            if(coverage[i] != 0)
                console.log(`bad coverage ${i} ${coverage[i]}`)
        }
    }
        
    //todo exhaustive search for non verified senders
    //this actually requires an additional coarse external means to rule out senders
    //i.e. check if they are in the execution group for tellCorrespondingNodesFinalData
    //     check if they the node covers the storage range of accounts sent for tellCorrespondingNodes
    //the above coarse check is and-ed with verifyCorrespondingSender

    //a hacky/cheap way to test is to change the globalOffset before verification
}
