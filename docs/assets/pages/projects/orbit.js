/*
USING sun and earth:
Sun M: 1.989 * Math.pow(10, 30)
Earth's M: 5.972 * Math.pow(10, 24)
Earth's orbital speed: 30 * Math.pow(10, 3)
Earth's distance: 149.6 * Math.pow(10, 9)
G = 6.67408 * Math.pow(10, -11)
*/

//Smaller planets cordinates
x = 149.6 * Math.pow(10, 9);
y = 0.1

//Larger planet cord
x2 = 0;
y2 = 0;

//Variables
G = 6.67408 * Math.pow(10, -11);
m = 5.972 * Math.pow(10, 30);        //mass in kg
M = 1.989 * Math.pow(10, 30);         //mass in kg

// Step-size
dt = 10000;

//Smaller x-y speed
Xs = 0;
Ys = 30 * Math.pow(10, 3);

//Larger x-y speed
Xs2 = 0;
Ys2 = 0;

//Smallers Forces:
Fx = 0;
Fy = 0;

//Largers forces:
Fx2 = 0;
Fy2 = 0;



A = 0;
B = 0;
C = 0;

w = window.innerWidth.toString();
h = window.innerHeight.toString();

var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
svg.setAttribute('id', 'svg-container');
svg.setAttribute('style', 'border: 1px solid black');
svg.setAttribute('width', w);
svg.setAttribute('height', h);
svg.setAttribute('viewBox', '-2000 -2000 4000 4000');
svg.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns:xlink", "http://www.w3.org/1999/xlink");
document.body.appendChild(svg);

//Sets var VB to an array of the viewBox numbers
var VB = svg.getAttribute('viewBox').split(' ').map(Number);

window.addEventListener('keyup', (key) => {
    if (key.keyCode === 37) {
        VB[0] -= 1000;
        svg.setAttribute('viewBox', VB);
    }

    if (key.keyCode === 39) {
        VB[0] += 1000;
        svg.setAttribute('viewBox', VB);
    }

    if (key.keyCode === 38) {
        VB[1] -= 1000;
        svg.setAttribute('viewBox', VB);
    }

    if (key.keyCode === 40) {
        VB[1] += 1000;
        svg.setAttribute('viewBox', VB);
    }

    //Zooming in and out
    if (key.keyCode === 187) {
        VB[2] += 1000;
        VB[3] += 1000;
        svg.setAttribute('viewBox', VB);
        console.log(VB);
        console.log(x / 100000000);
    }

    if (key.keyCode === 189) {
        VB[2] -= 1000;
        VB[3] -= 1000;
        svg.setAttribute('viewBox', VB);
        console.log(VB);
        console.log(x / 100000000 + "y:" + y / 100000000);
    }
});


function euler() {
    //use i<33000 with dt = 1000
    for (let i = 0; i < 3300; i++) {

        A = (G ** 2 * M ** 2 * m ** 2) / ((x ** 2 + y ** 2) ** 2);
        B = (((x - x2) ** 2) / ((y -y2) ** 2)) + 1;
        C = ((y ** 2) / (x ** 2)) + 1;

        Fy = Math.sqrt(A / B) * (-y / Math.abs(y));
        Fx = Math.sqrt(A / C) * (-x / Math.abs(x));



        //Calculating Smaller 
        ax = Fx / m;
        ay = Fy / m;

        x = x + Xs * dt;
        y = y + Ys * dt;

        Xs = Xs + ax * dt;
        Ys = Ys + ay * dt;

        //Calculating Larger
        ax2 = -Fx / M;
        ay2 = -Fy / M;

        x2 = x2 + Xs2 * dt;
        y2 = y2 + Ys2 * dt;

        Xs2 = Xs2 + ax2 * dt;
        Ys2 = Ys2 + ay2 * dt;

        //drawing vars
        cx = x / 100000000;
        cy = y / 100000000;

        Cx = x2 / 100000000;
        Cy = y2 / 100000000;

        //Drawing smaller
        var rect = document.createElementNS("http://www.w3.org/2000/svg", 'rect');
        rect.setAttribute('x', cx);
        rect.setAttribute('y', cy);
        rect.setAttribute('width', 20);
        rect.setAttribute('height', 20);
        rect.setAttribute('fill', '#34eb34');
        svg.appendChild(rect);
        document.body.appendChild(svg);

        //Drawing Larger
        var rect2 = document.createElementNS("http://www.w3.org/2000/svg", 'circle');
        rect2.setAttribute('cx', Cx);
        rect2.setAttribute('cy', Cy);
        rect2.setAttribute('r', 20);
        rect2.setAttribute('fill', '#ebe134');
        svg.appendChild(rect2);
        document.body.appendChild(svg);

        console.log("x:" + Fx);
        console.log("y:" + Fy);
    
    }
}