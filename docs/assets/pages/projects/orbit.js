/*
USING sun and earth:
Sun M: 1.989 * Math.pow(10, 30)
Earth's M: 5.972 * Math.pow(10, 24)
Earth's orbital speed: 29.29 * Math.pow(10, 3)
Earth's distance: 152.1 * Math.pow(10, 9)
G = 6.67408 * Math.pow(10, -11)

31 536 000 seconds per year
i = 31536, dt = 1000 yields 1 year
*/

var G = 6.673E-11;
var m1 = 5.972E24;
var m2 = 1.98847E30;
var x1 = 152.1E9;
var x2 = 0;
var y1 = 0;
var y2 = 0;
var v1x = 0;
var v2x = 0;
var v1y = 29.29E3;
var v2y = 0;

var dt = 1;

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

    }

    if (key.keyCode === 189) {
        VB[2] -= 1000;
        VB[3] -= 1000;
        svg.setAttribute('viewBox', VB);
        console.log(VB);
    }
});


function euler() {
    iteration = 0;
    original_x = x1;
    original_y = y1;

    draw_every_100_step = 0;

    cx = x1 / 100000000;
    cy = y1 / 100000000;


    dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)

    V1 = Math.sqrt((v1x ** 2) + (v1y ** 2));
    Ek1 = (m1 * (V1 ** 2)) / 2; 
    Ep1 = G * m1 * m2 / dist;
    Et1 = Ek1 - Ep1;

    V2 = Math.sqrt((v2x ** 2) + (v2y ** 2));
    Ek2 = (m2 * (V2 ** 2)) / 2; 
    Ep2 = G * m1 * m2 / dist;
    Et2 = Ek2 - Ep2;
    console.log( "Ek1 = " + Ek1, "Ek2 = " + Ek2, "Ep1 = " + Ep1, "Ep2 = " + Ep2, "Et1 = " + Et1, "Et2 = " + Et2, "E = " + (Et1 + Et2));
    original_E = (Et1 + Et2);


    var end = document.createElementNS("http://www.w3.org/2000/svg", 'circle');
    end.setAttribute('cx', cx);
    end.setAttribute('cy', cy);
    end.setAttribute('r', 20);
    end.setAttribute('fill', '#eb34ab');
    svg.appendChild(end);
    document.body.appendChild(svg);

    //use i<33000 with dt = 1000
    for (let i = 0; i < 31536000; i++) {

        dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
        F = G * m1 * m2 / (dist * dist)

        F1x = F * (x2 - x1) / dist
        F1y = F * (y2 - y1) / dist
        F2x = -F1x
        F2y = -F1y

        a1x = F1x / m1
        a1y = F1y / m1
        a2x = F2x / m2
        a2y = F2y / m2



        x1 = x1 + v1x * dt
        y1 = y1 + v1y * dt
        x2 = x2 + v2x * dt
        y2 = y2 + v2y * dt
        v1x = v1x + a1x * dt
        v1y = v1y + a1y * dt
        v2x = v2x + a2x * dt
        v2y = v2y + a2y * dt

        
        //drawing vars
        cx = x1 / 100000000;
        cy = y1 / 100000000;

        Cx = x2 / 100000000;
        Cy = y2 / 100000000;

        if (draw_every_100_step == 100000) {
            //Drawing smaller
            var rect = document.createElementNS("http://www.w3.org/2000/svg", 'rect');
            rect.setAttribute('x', cx);
            rect.setAttribute('y', cy);
            rect.setAttribute('width', 10);
            rect.setAttribute('height', 10);
            rect.setAttribute('fill', '#34eb34');
            svg.appendChild(rect);
            document.body.appendChild(svg);

            //Drawing Larger
            var rect2 = document.createElementNS("http://www.w3.org/2000/svg", 'circle');
            rect2.setAttribute('cx', Cx);
            rect2.setAttribute('cy', Cy);
            rect2.setAttribute('r', 50);
            rect2.setAttribute('fill', '#ebe134');
            svg.appendChild(rect2);
            document.body.appendChild(svg);
            draw_every_100_step = 0;
        }
        
        iteration = iteration + 1;
        draw_every_100_step = draw_every_100_step + 1;
        
    }
    var end = document.createElementNS("http://www.w3.org/2000/svg", 'circle');
    end.setAttribute('cx', cx);
    end.setAttribute('cy', cy);
    end.setAttribute('r', 20);
    end.setAttribute('fill', '#428df5');
    svg.appendChild(end);
    document.body.appendChild(svg);


    dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)

    V1 = Math.sqrt((v1x ** 2) + (v1y ** 2));
    Ek1 = (m1 * (V1 ** 2)) / 2; 
    Ep1 = G * m1 * m2 / dist;
    Et1 = Ek1 - Ep1;

    V2 = Math.sqrt((v2x ** 2) + (v2y ** 2));
    Ek2 = (m2 * (V2 ** 2)) / 2; 
    Ep2 = G * m1 * m2 / dist;
    Et2 = Ek2 - Ep2;

    //console.log( "Ek1 = " + Ek1, "Ek2 = " + Ek2, "Ep1 = " + Ep1, "Ep2 = " + Ep2, "Et1 = " + Et1, "Et2 = " + Et2, "E = " + (Et1 + Et2));
    //console.log((Et1 + Et2) - original_E);

    console.log(dist);


}

function euler_cromer() {
    iteration = 0;
    original_x = x1;
    original_y = y1;

    draw_every_100_step = 0;

    cx = x1 / 100000000;
    cy = y1 / 100000000;

    dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)

    V1 = Math.sqrt((v1x ** 2) + (v1y ** 2));
    Ek1 = (m1 * (V1 ** 2)) / 2; 
    Ep1 = G * m1 * m2 / dist;
    Et1 = Ek1 - Ep1;

    V2 = Math.sqrt((v2x ** 2) + (v2y ** 2));
    Ek2 = (m2 * (V2 ** 2)) / 2; 
    Ep2 = G * m1 * m2 / dist;
    Et2 = Ek2 - Ep2;

    console.log( "Ek1 = " + Ek1, "Ek2 = " + Ek2, "Ep1 = " + Ep1, "Ep2 = " + Ep2, "Et1 = " + Et1, "Et2 = " + Et2, "E = " + (Et1 + Et2));
    original_E = (Et1 + Et2);


    var end = document.createElementNS("http://www.w3.org/2000/svg", 'circle');
    end.setAttribute('cx', cx);
    end.setAttribute('cy', cy);
    end.setAttribute('r', 20);
    end.setAttribute('fill', '#eb34ab');
    svg.appendChild(end);
    document.body.appendChild(svg);

    //use i<33000 with dt = 1000
    for (let i = 0; i < 31536000; i++) {

        dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
        F = G * m1 * m2 / (dist * dist)

        F1x = F * (x2 - x1) / dist
        F1y = F * (y2 - y1) / dist
        F2x = -F1x
        F2y = -F1y

        a1x = F1x / m1
        a1y = F1y / m1
        a2x = F2x / m2
        a2y = F2y / m2

        v1x = v1x + a1x * dt
        v1y = v1y + a1y * dt
        v2x = v2x + a2x * dt
        v2y = v2y + a2y * dt

        x1 = x1 + v1x * dt
        y1 = y1 + v1y * dt
        x2 = x2 + v2x * dt
        y2 = y2 + v2y * dt
        
        //drawing vars
        cx = x1 / 100000000;
        cy = y1 / 100000000;

        Cx = x2 / 100000000;
        Cy = y2 / 100000000;

        if (draw_every_100_step == 100000) {
            //drawing vars
            cx = x1 / 100000000;
            cy = y1 / 100000000;

            Cx = x2 / 100000000;
            Cy = y2 / 100000000;
            //Drawing smaller
            var rect = document.createElementNS("http://www.w3.org/2000/svg", 'rect');
            rect.setAttribute('x', cx);
            rect.setAttribute('y', cy);
            rect.setAttribute('width', 10);
            rect.setAttribute('height', 10);
            rect.setAttribute('fill', '#34eb34');
            svg.appendChild(rect);
            document.body.appendChild(svg);

            //Drawing Larger
            var rect2 = document.createElementNS("http://www.w3.org/2000/svg", 'circle');
            rect2.setAttribute('cx', Cx);
            rect2.setAttribute('cy', Cy);
            rect2.setAttribute('r', 50);
            rect2.setAttribute('fill', '#ebe134');
            svg.appendChild(rect2);
            document.body.appendChild(svg);

            draw_every_100_step = 0;
        }
        
        iteration = iteration + 1;
        draw_every_100_step = draw_every_100_step + 1;

    }

    cx = x1 / 100000000;
    cy = y1 / 100000000;

    var end = document.createElementNS("http://www.w3.org/2000/svg", 'circle');
    end.setAttribute('cx', cx);
    end.setAttribute('cy', cy);
    end.setAttribute('r', 20);
    end.setAttribute('fill', '#428df5');
    svg.appendChild(end);
    document.body.appendChild(svg);

    /*
    dist = (Math.pow(x1-original_x, 2) + Math.pow(y1-original_y, 2))
    distance = Math.sqrt(dist);

    console.log(distance);
    fel_per_iteration = distance / iteration;

    console.log(fel_per_iteration);
    */
    dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)

    V1 = Math.sqrt((v1x ** 2) + (v1y ** 2));
    Ek1 = (m1 * (V1 ** 2)) / 2; 
    Ep1 = G * m1 * m2 / dist;
    Et1 = Ek1 - Ep1;

    V2 = Math.sqrt((v2x ** 2) + (v2y ** 2));
    Ek2 = (m2 * (V2 ** 2)) / 2; 
    Ep2 = G * m1 * m2 / dist;
    Et2 = Ek2 - Ep2;
    
    //console.log( "Ek1 = " + Ek1, "Ek2 = " + Ek2, "Ep1 = " + Ep1, "Ep2 = " + Ep2, "Et1 = " + Et1, "Et2 = " + Et2, "E = " + (Et1 + Et2));
    //console.log((Et1 + Et2) - original_E);
    console.log(dist);
}

function impEuler() {
    iteration = 0;
    original_x = x1;
    original_y = y1;

    draw_every_100_step = 0;

    cx = x1 / 100000000;
    cy = y1 / 100000000;



    dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)

    V1 = Math.sqrt((v1x ** 2) + (v1y ** 2));
    Ek1 = (m1 * (V1 ** 2)) / 2; 
    Ep1 = G * m1 * m2 / dist;
    Et1 = Ek1 - Ep1;

    V2 = Math.sqrt((v2x ** 2) + (v2y ** 2));
    Ek2 = (m2 * (V2 ** 2)) / 2; 
    Ep2 = G * m1 * m2 / dist;
    Et2 = Ek2 - Ep2;
    console.log( "Ek1 = " + Ek1, "Ek2 = " + Ek2, "Ep1 = " + Ep1, "Ep2 = " + Ep2, "Et1 = " + Et1, "Et2 = " + Et2, "E = " + (Et1 + Et2));
    original_E = (Et1 + Et2);



    var end = document.createElementNS("http://www.w3.org/2000/svg", 'circle');
    end.setAttribute('cx', cx);
    end.setAttribute('cy', cy);
    end.setAttribute('r', 20);
    end.setAttribute('fill', '#eb34ab');
    svg.appendChild(end);
    document.body.appendChild(svg);

    //use i<33000 with dt = 1000
    for (let i = 0; i < 31536000; i++) {

        dist=Math.sqrt((x2-x1)**2+(y2-y1)**2)
        F=G*m1*m2/(dist*dist)
    
        F1x=F*(x2-x1)/dist
        F1y=F*(y2-y1)/dist
        F2x=-F1x
        F2y=-F1y
    
        a1x=F1x/m1
        a1y=F1y/m1
        a2x=F2x/m2
        a2y=F2y/m2
    
    
        v01x=v1x
        v01y=v1y
        v02x=v2x
        v02y=v2y
        v1x=v1x+a1x*dt
        v1y=v1y+a1y*dt
        v2x=v2x+a2x*dt
        v2y=v2y+a2y*dt
       
    
        x1=x1+(v1x+v01x)*0.5*dt
        y1=y1+(v1y+v01y)*0.5*dt
        x2=x2+(v2x+v02x)*0.5*dt
        y2=y2+(v2y+v02y)*0.5*dt


        if (draw_every_100_step == 100000) {

            //drawing vars
            cx = x1 / 100000000;
            cy = y1 / 100000000;

            Cx = x2 / 100000000;
            Cy = y2 / 100000000;

            //Drawing smaller
            var rect = document.createElementNS("http://www.w3.org/2000/svg", 'rect');
            rect.setAttribute('x', cx);
            rect.setAttribute('y', cy);
            rect.setAttribute('width', 10);
            rect.setAttribute('height', 10);
            rect.setAttribute('fill', '#34eb34');
            svg.appendChild(rect);
            document.body.appendChild(svg);

            //Drawing Larger
            var rect2 = document.createElementNS("http://www.w3.org/2000/svg", 'circle');
            rect2.setAttribute('cx', Cx);
            rect2.setAttribute('cy', Cy);
            rect2.setAttribute('r', 50);
            rect2.setAttribute('fill', '#ebe134');
            svg.appendChild(rect2);
            document.body.appendChild(svg);

            draw_every_100_step = 0;
        }
        iteration = iteration + 1;
        draw_every_100_step = draw_every_100_step + 1;
    }

    cx = x1 / 100000000;
    cy = y1 / 100000000;

    Cx = x2 / 100000000;
    Cy = y2 / 100000000;

    var end = document.createElementNS("http://www.w3.org/2000/svg", 'circle');
    end.setAttribute('cx', cx);
    end.setAttribute('cy', cy);
    end.setAttribute('r', 20);
    end.setAttribute('fill', '#428df5');
    svg.appendChild(end);
    document.body.appendChild(svg);

    dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)

    V1 = Math.sqrt((v1x ** 2) + (v1y ** 2));
    Ek1 = (m1 * (V1 ** 2)) / 2; 
    Ep1 = G * m1 * m2 / dist;
    Et1 = Ek1 - Ep1;

    V2 = Math.sqrt((v2x ** 2) + (v2y ** 2));
    Ek2 = (m2 * (V2 ** 2)) / 2; 
    Ep2 = G * m1 * m2 / dist;
    Et2 = Ek2 - Ep2;

   // console.log( "Ek1 = " + Ek1, "Ek2 = " + Ek2, "Ep1 = " + Ep1, "Ep2 = " + Ep2, "Et1 = " + Et1, "Et2 = " + Et2, "E = " + (Et1 + Et2));
  //  console.log((Et1 + Et2) - original_E);
    console.log(dist);
}